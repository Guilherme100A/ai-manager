// CI-only observation. Never changes the host network or application behavior.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { snapshot as listenerSnapshot } from './listener-diagnostic.mjs'

const networkCodes = new Set(['net::ERR_NETWORK_CHANGED', 'net::ERR_ABORTED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_FAILED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_RESET', 'net::ERR_TIMED_OUT', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_EMPTY_RESPONSE'])
const safeCode = error => {
  const code = String(error?.message ?? error ?? '').match(/\bnet::ERR_[A-Z_]+\b/)?.[0]
  return networkCodes.has(code) ? code : (['TimeoutError', 'TypeError', 'SyntaxError'].includes(error?.name) ? error.name : 'error')
}
const actions = new Set(['create', 'destroy', 'connect', 'disconnect', 'start', 'stop', 'die', 'kill', 'restart', 'pause', 'unpause', 'health_status: healthy', 'health_status: unhealthy', 'health_status: starting'])
export function mimeEvidence(value) {
  const mime = String(value ?? '').split(';')[0].trim().toLowerCase()
  return ['text/html', 'application/javascript', 'text/javascript', 'text/css', 'image/png', 'image/svg+xml', 'application/json', 'text/plain', 'text/event-stream', 'application/octet-stream'].includes(mime) ? mime : 'other'
}
export function composeLogEvidence(raw, sanitizeUrl, maxBytes = 512 * 1024) {
  const lines = raw.split('\n'), rows = []
  let bytes = 0, dropped = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const service = line.match(/\b(crm-api|crm-web|dashboard|postgres|redis)-\d+\s+\|/)?.[1]
    if (!service) { dropped++; continue }
    const time = line.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/)?.[0]
    const http = line.match(/"(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) ([^"\s]+) HTTP\/[\d.]+" (\d{3})/)
    const level = line.match(/\[(warn|error|crit|emerg|notice|info|debug)\]/)?.[1]
    const row = { service, ...(time ? { source_utc: time } : { source_time_unavailable: true }),
      ...(http ? { kind: 'http', method: http[1], url: sanitizeUrl('http://127.0.0.1' + http[2]), status: Number(http[3]) } : { kind: 'service_log', ...(level ? { severity: level } : {}) }) }
    const serialized = JSON.stringify(row) + '\n'
    if (bytes + Buffer.byteLength(serialized) > maxBytes - 1024 || rows.length >= 2000) { dropped++; continue }
    rows.push(serialized); bytes += Buffer.byteLength(serialized)
  }
  rows.push(JSON.stringify({ truncated: dropped > 0, dropped, reason: dropped ? 'compose_projection_limit_or_unrecognized_line' : 'complete_projection' }) + '\n')
  return rows.join('')
}
export function privateComposeConfig(source, content, io = fs) {
  // Current workflow uploads reports and test-results/T004-D01 only. Keep raw
  // operational config outside both trees, not merely hidden inside reports.
  const parent = path.join(source, 'test-results')
  io.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const dir = io.mkdtempSync(path.join(parent, '.ci02-private-'))
  const file = path.join(dir, 'compose.json')
  const cleanup = () => {
    try { io.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    finally { io.rmdirSync(dir) } // This invocation's unique directory, never recursive.
  }
  try { io.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }) } catch (error) {
    try { cleanup() } catch { /* preserve the write failure */ }
    throw error
  }
  return { file, cleanup }
}
export async function finishBeforeTeardown(diagnostic, steps, primaryError, beforeFinish = []) {
  let cleanupError
  try { diagnostic.emit('harness', 'teardown_pending') } catch (error) { cleanupError = error }
  for (const step of [...beforeFinish, () => diagnostic.finish(), ...steps]) {
    try { await step() } catch (error) { cleanupError ??= error }
  }
  if (!primaryError && cleanupError) throw cleanupError
}
export function dockerEvent(raw, project, hash) {
  if (!['network', 'container'].includes(raw.Type) || !actions.has(raw.Action)) return null
  const own = raw.Actor?.Attributes?.['com.docker.compose.project'] === project
  if (!own && raw.Type !== 'network') return null
  const time = Number(raw.time)
  return { type: raw.Type, action: raw.Action, project_scoped: own,
    ...(own ? { object_id: hash(raw.Actor?.ID ?? raw.id ?? '') } : { outside_project_count: 1 }),
    ...(Number.isSafeInteger(time) && time > 0 && time < 8640000000000 ? { source_utc: new Date(time * 1000).toISOString() } : {}) }
}
export function linkEvent(line, hash) {
  if (!line.trim()) return null
  // Raw ip-monitor output (addresses, routes and interface names) stays in memory.
  const type = /\binet6?\b/.test(line) ? 'address' : /(?:^|\s)\d+:/.test(line) ? 'link' : 'route'
  const time = line.match(/^\[([^\]]+)\]/)?.[1] ?? line.match(/^Timestamp:\s*(.+)$/)?.[1]
  const parsed = time ? Date.parse(time) : NaN
  return { type, change_id: hash(line), state: /\bstate UP\b/.test(line) ? 'up' : /\bstate DOWN\b/.test(line) ? 'down' : 'unknown', ...(Number.isFinite(parsed) ? { source_utc: new Date(parsed).toISOString() } : { source_time_unavailable: true }) }
}
export function errorEvidence(error) {
  const match = String(error?.message ?? '').match(/^locator\.waitFor: Timeout \d+ms exceeded\.?/)
  return { name: ['Error', 'TimeoutError', 'TypeError', 'SyntaxError'].includes(error?.name) ? error.name : 'Error', message: match?.[0] ?? safeCode(error) }
}
export function pageEvidence(raw, sanitizeUrl = () => '[redacted-url]') {
  return { url: sanitizeUrl(raw.url), frame_urls: (raw.frame_urls ?? []).slice(0, 16).map(sanitizeUrl), readyState: ['loading', 'interactive', 'complete'].includes(raw.readyState) ? raw.readyState : 'unknown', title: raw.title === 'CRM' ? 'CRM' : '[redacted]',
    body: raw.body === '' ? '' : '[fixture text redacted]', root: raw.root === '' ? '' : (String(raw.root ?? '').match(/<\/?[a-zA-Z][a-zA-Z0-9-]*/g) ?? []).slice(0, 128).join('>') }
}

export function createDiagnostic({ report, project, composeFile, env = process.env,
  clock = { utc: () => new Date().toISOString(), mono: () => process.hrtime.bigint() },
  io = fs, launch = spawn, sink, probeTimers = { setTimeout, clearTimeout }, maxBytes = 2 * 1024 * 1024, maxEvents = 10000, salt = randomBytes(16).toString('hex') } = {}) {
  const started = clock.mono(), hash = value => createHash('sha256').update(salt + String(value)).digest('hex').slice(0, 20)
  const allowedPaths = new Set(['/', '/crm/welcome', '/crm/flows', '/flows', '/crm/api/auth/profile', '/crm/.well-known/oauth-authorization-server'])
  const ports = new Set()
  let seq = 0, bytes = 0, dropped = 0, ioFailed = false, finished = false, truncated = false
  const truncationReasons = new Set()
  let fd
  const children = new Set(), pending = new Set(), availability = {}, histories = []
  if (!sink) {
    try {
      fd = io.openSync(path.join(report, `nginx-timeline-${process.pid}-${randomBytes(4).toString('hex')}.jsonl`), 'wx', 0o600)
      sink = line => io.writeSync(fd, line)
    } catch { ioFailed = true; sink = () => {} }
  }
  const identity = {
    run_id: /^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? env.GITHUB_RUN_ID : 'unknown',
    run_attempt: /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ? env.GITHUB_RUN_ATTEMPT : 'unknown',
    SHA: /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : 'unknown', phase: 'nginx',
  }
  const emit = (source, event, data = {}, final = false) => {
    if (finished) return null
    const row = { seq: ++seq, ...identity, utc: clock.utc(), monotonic_ms: Number(clock.mono() - started) / 1e6, source, event, ...data }
    const line = JSON.stringify(row) + '\n'
    if (!final && (bytes + Buffer.byteLength(line) > maxBytes - 2048 || seq > maxEvents)) { dropped++; truncated = true; truncationReasons.add('timeline_limit'); return row }
    try { sink(line); bytes += Buffer.byteLength(line) } catch { ioFailed = true }
    return row
  }
  const url = value => {
    try {
      const u = new URL(value), local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && ['http:', 'https:'].includes(u.protocol)
      const origin = u.protocol === 'http:' && u.hostname === 'dashboard' && !u.port ? 'http://dashboard' : local ? `${u.protocol}//loopback${u.port ? ':' + u.port : ''}` : '<origin-' + hash(u.origin) + '>'
      return origin + (allowedPaths.has(u.pathname) ? u.pathname : '/<path-' + hash(u.pathname) + '>')
    } catch { return '[redacted-url]' }
  }
  const track = promise => { pending.add(promise); promise.finally(() => pending.delete(promise)); return promise }
  const probe = (exe, args, consume) => track(new Promise(resolve => {
    const collector = args[0] === 'inspect' ? 'container_state' : args.includes('ps') ? 'containers' : args[0] === 'version' ? 'docker_version' : 'compose_version'
    let child, buffer = '', done = false, overflow = false
    const end = (status, signal, reason) => {
      if (done) return; done = true; probeTimers.clearTimeout(timer); if (child) children.delete(child)
      if (status === 0 && !overflow) { try { consume(buffer) } catch { emit('collector', 'unavailable', { collector, reason: 'projection_failed' }) } }
      else emit('collector', 'unavailable', { collector, reason, exitCode: Number.isInteger(status) ? status : null, signal: /^SIG[A-Z]+$/.test(signal ?? '') ? signal : null })
      resolve()
    }
    const timer = probeTimers.setTimeout(() => { child?.kill('SIGKILL'); end(null, 'SIGKILL', 'probe_timeout') }, 2000)
    try {
      child = launch(exe, args, { stdio: ['ignore', 'pipe', 'ignore'] }); children.add(child)
      child.stdout?.on('data', chunk => { buffer += chunk; if (buffer.length > 65536) { overflow = true; child.kill('SIGKILL'); end(null, 'SIGKILL', 'probe_limit') } })
      child.once('error', () => end(null, null, 'probe_unavailable'))
      child.once('close', (code, signal) => end(code, signal, 'probe_failed'))
    } catch { end(null, null, 'probe_unavailable') }
  }))
  const monitors = []
  const monitor = (name, exe, args, projectLine) => {
    let child, buffer = '', lines = 0, stopping = false, done = false, resolveClosed
    const closed = new Promise(resolve => { resolveClosed = resolve })
    const complete = (code, signal) => {
      if (done) return; done = true; children.delete(child)
      availability[name] = stopping ? availability[name] : false
      emit('collector', stopping ? 'stopped' : 'unavailable', { collector: name, availability: availability[name] === true, reason: stopping ? 'own_collector_closed' : 'monitor_ended', exitCode: Number.isInteger(code) ? code : null, signal: /^SIG[A-Z]+$/.test(signal ?? '') ? signal : null })
      resolveClosed()
    }
    availability[name] = false
    try {
      child = launch(exe, args, { stdio: ['ignore', 'pipe', 'ignore'] }); children.add(child)
      child.once('spawn', () => { availability[name] = true; emit('collector', 'available', { collector: name, availability: true }) })
      child.stdout?.on('data', chunk => {
        buffer += chunk
        if (buffer.length > 65536) { truncated = true; dropped++; truncationReasons.add('line_limit'); availability[name] = false; emit('collector', 'truncated', { collector: name, truncated: true, reason: 'line_limit' }); stopping = true; child.kill('SIGTERM'); buffer = ''; return }
        for (;;) {
          const split = buffer.indexOf('\n'); if (split < 0) break
          const line = buffer.slice(0, split); buffer = buffer.slice(split + 1)
          if (++lines > 5000) { dropped++; truncated = true; truncationReasons.add('monitor_event_limit'); continue }
          try { const data = projectLine(line); if (data) emit(name, 'change', data) } catch { emit('collector', 'unavailable', { collector: name, reason: 'event_projection_failed' }) }
        }
      })
      child.once('error', () => complete(null, null))
      child.once('close', complete)
    } catch { complete(null, null) }
    monitors.push(async () => {
      if (done) return
      stopping = true; child.kill('SIGTERM')
      let timer
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); emit('collector', 'stop_timeout', { collector: name, reason: 'own_collector_stop_timeout' }); resolve() }, 250) })])
      clearTimeout(timer)
    })
  }
  const networkSnapshot = stage => {
    try {
      const links = Object.entries(os.networkInterfaces()).map(([name, addresses]) => {
        let state = 'unavailable'
        try { const value = io.readFileSync('/sys/class/net/' + name + '/operstate', 'utf8').trim(); if (['up', 'down', 'unknown', 'dormant', 'lowerlayerdown', 'notpresent', 'testing'].includes(value)) state = value } catch { /* optional interface observation */ }
        return { id: hash(name), state, addresses: addresses?.length ?? 0, topology_id: hash(JSON.stringify(addresses)) }
      })
      const routes = ['/proc/net/route', '/proc/net/ipv6_route'].map(file => hash(io.readFileSync(file, 'utf8')))
      let namespace_id = null
      try { namespace_id = createHash('sha256').update(io.readlinkSync('/proc/self/ns/net')).digest('hex') } catch { /* explicitly unavailable */ }
      emit('host', 'snapshot', { stage, scope: 'runner', availability: true, links, route_ids: routes, namespace_id, namespace_available: namespace_id !== null })
    } catch { emit('host', 'snapshot', { stage, availability: false, reason: 'network_snapshot_unavailable' }) }
  }
  const containerSnapshot = stage => {
    if (!composeFile) return Promise.resolve()
    return probe('docker', ['compose', '-p', project, '-f', composeFile, 'ps', '-aq'], text => {
      const ids = text.trim().split(/\s+/).filter(id => /^[a-f0-9]{12,64}$/.test(id)).slice(0, 16)
      for (const id of ids) probe('docker', ['inspect', '--format', '{{json .State}}\t{{json .RestartCount}}\t{{json .NetworkSettings.Networks}}\t{{json (index .Config.Labels "com.docker.compose.service")}}\t{{json .Image}}', id], text => {
        const [state, restarts, networks, service, image] = text.trim().split('\t').map(v => JSON.parse(v))
        emit('docker', 'snapshot', { stage, container_id: hash(id), service: ['browser', 'crm-api', 'crm-web', 'dashboard', 'postgres', 'redis'].includes(service) ? service : 'unknown', image_id: /^sha256:[a-f0-9]{64}$/.test(image ?? '') ? image : null, state: ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(state.Status) ? state.Status : 'unknown', health: ['healthy', 'unhealthy', 'starting'].includes(state.Health?.Status) ? state.Health.Status : 'none', restarts: Number.isSafeInteger(restarts) && restarts >= 0 ? restarts : null, network_ids: Object.values(networks ?? {}).map(n => hash(n.NetworkID)).slice(0, 16) })
      })
    })
  }
  const snapshot = stage => {
    networkSnapshot(stage)
    try {
      const listeners = ports.size ? listenerSnapshot('/proc').listeners.filter(l => ports.has(l.port)) : []
      emit('host', 'listeners', { stage, availability: ports.size > 0, listeners, ...(ports.size ? {} : { reason: 'ports_not_known_yet' }) })
    } catch { emit('host', 'listeners', { stage, availability: false, reason: 'listeners_unavailable' }) }
    return containerSnapshot(stage)
  }
  const start = () => {
    emit('harness', 'start', { instrumentation_may_change_timing: true, timestamp_semantics: 'node_callback_receive_time', synchronous_commands_may_delay_callbacks: true })
    emit('runner', 'metadata', {
      node: process.versions.node, os: ['Linux', 'Windows', 'macOS'].includes(env.RUNNER_OS) ? env.RUNNER_OS : 'unknown', arch: ['X64', 'ARM64', 'X86'].includes(env.RUNNER_ARCH) ? env.RUNNER_ARCH : 'unknown',
      image: /^(ubuntu|windows|macos)[-\d.]*$/.test(env.ImageOS ?? '') ? env.ImageOS : 'unknown', image_version: /^[\d.]+$/.test(env.ImageVersion ?? '') ? env.ImageVersion : 'unknown',
    })
    let linkTime
    monitor('link', 'ip', ['-ts', '-o', 'monitor', 'link', 'address', 'route'], line => {
      // iproute2 may put the timestamp on its own line. It is not a route event.
      if (/^Timestamp:/.test(line)) { const parsed = Date.parse(line.replace(/^Timestamp:\s*/, '')); linkTime = Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined; return null }
      const data = linkEvent(line, hash)
      if (data && linkTime) { data.source_utc = linkTime; delete data.source_time_unavailable }
      linkTime = undefined
      return data
    })
    monitor('docker', 'docker', ['events', '--format', '{{json .}}', '--filter', 'type=network', '--filter', 'type=container'], line => dockerEvent(JSON.parse(line), project, hash))
    networkSnapshot('before_compose')
  }
  let versions
  const collectVersions = () => versions ??= Promise.allSettled([
    probe('docker', ['version', '--format', '{{.Server.Version}}'], text => emit('docker', 'version', { version: /^v?\d+(\.\d+){1,3}(-rc\d+)?$/.test(text.trim()) ? text.trim() : 'unknown' })),
    probe('docker', ['compose', 'version', '--short'], text => emit('compose', 'version', { version: /^v?\d+(\.\d+){1,3}(-rc\d+)?$/.test(text.trim()) ? text.trim() : 'unknown' })),
  ])
  const operation = (name, fn) => {
    if (!/^(compose_up|nginx_t_(crm-web|dashboard)|http_probe|api_probe|discovery_probe|chromium_launch|chromium_connect|browser_readiness|browser_observer_ready|goto_(welcome|direct_flows|missing_flow)|click_(flows|retry|reload)|wait_packaged-(welcome|flows|direct-flows|error|budget-exhausted|recovered))$/.test(name)) name = 'operation'
    const processOperation = name === 'compose_up' || name.startsWith('nginx_t_')
    const source = processOperation ? 'wrapper' : 'harness'
    const unavailable = { signal: null, signal_unavailable: true, timeout: null, timeout_unavailable: true }
    const success = () => emit(source, 'end', { operation: name, label: name, outcome: 'ok', ...(processOperation ? { exitCode: 0, exit_status_unavailable: false, ...unavailable } : {}) })
    const failure = error => emit(source, 'end', { operation: name, label: name, outcome: 'failed', error: safeCode(error), ...(processOperation ? { exitCode: null, exit_status_unavailable: true, ...unavailable } : {}) })
    emit(source, 'begin', { operation: name, label: name })
    try {
      const value = fn()
      if (value?.then) return value.then(result => { success(); return result }, error => { failure(error); throw error })
      success(); return value
    } catch (error) { failure(error); throw error }
  }
  const attach = (page, browser, pageErrors) => {
    const events = { pageErrors: [], consoleErrors: [], failedRequests: [], failedResponses: [], responses: [], dropped: 0 }
    const requests = new WeakMap(), frames = new WeakMap(), frameNav = new WeakMap(); let rid = 0, fid = 0, nav = 0
    const frameId = frame => { if (!frame || typeof frame !== 'object') return 'none'; if (!frames.has(frame)) frames.set(frame, 'f' + ++fid); return frames.get(frame) }
    const requestData = request => {
      if (!requests.has(request)) {
        let frame
        try { frame = request.frame() } catch { /* e.g. a worker request has no frame */ }
        const navigation = request.isNavigationRequest()
        if (navigation) { nav++; if (frame) frameNav.set(frame, 'n' + nav) }
        requests.set(request, { request_id: 'r' + ++rid, nav_id: navigation ? 'n' + nav : frame ? frameNav.get(frame) ?? 'n0' : 'n0', frame_id: frameId(frame), ...(!frame ? { frame_unavailable: true } : {}) })
      }
      const resource = request.resourceType()
      return { ...requests.get(request), url: url(request.url()), resource: ['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other'].includes(resource) ? resource : 'other' }
    }
    const push = (key, row) => { if (events[key].length < 256) events[key].push(row); else { events.dropped++; truncated = true; truncationReasons.add('browser_history_limit') } }
    const callback = fn => (...args) => { try { fn(...args) } catch { emit('collector', 'unavailable', { reason: 'browser_projection_failed' }) } }
    page.on('request', callback(request => emit('browser', 'request', requestData(request))))
    page.on('requestfailed', callback(request => push('failedRequests', emit('browser', 'requestfailed', { ...requestData(request), error: safeCode(request.failure()?.errorText) }))))
    page.on('response', callback(response => {
      const row = emit('browser', 'response', { ...requestData(response.request()), status: response.status(), mime: mimeEvidence(response.headers()['content-type']) })
      push('responses', row); if (response.status() >= 400) push('failedResponses', row)
    }))
    page.on('pageerror', callback(error => { pageErrors.push(error.message); push('pageErrors', emit('browser', 'pageerror', { error: safeCode(error) })) }))
    page.on('console', callback(message => { if (message.type() === 'error') push('consoleErrors', emit('browser', 'console', { category: 'error', error: safeCode(message.text()) })) }))
    page.on('framenavigated', callback(frame => emit('browser', 'framenavigated', { frame_id: frameId(frame), nav_id: frameNav.get(frame) ?? 'n0', url: url(frame.url()) })))
    page.on('crash', callback(() => emit('browser', 'crash')))
    browser.on('disconnected', callback(() => emit('browser', 'disconnected')))
    histories.push(events)
    return events
  }
  const finish = async () => {
    if (finished) return
    emit('harness', 'collection_begin')
    try {
      snapshot('before_teardown')
      // Projections may schedule inspect probes from a completed ps probe.
      for (let i = 0; pending.size && i < 3; i++) await Promise.allSettled([...pending])
      await Promise.allSettled(monitors.map(stop => stop()))
      networkSnapshot('collectors_stopped')
    } catch { emit('collector', 'unavailable', { reason: 'final_collection_failed' }) }
    finally {
      for (const child of children) { try { child.kill('SIGKILL') } catch { /* only owned collectors/probes */ } }
      emit('harness', 'collection_end', { availability, truncated, dropped, truncation_reasons: [...truncationReasons], diagnostic_io_failed: ioFailed, browser_dropped: histories.reduce((n, h) => n + h.dropped, 0) }, true)
      finished = true
      if (fd !== undefined) { try { io.closeSync(fd) } catch { /* never mask the primary failure */ } }
    }
  }
  return { start, collectVersions, snapshot, operation, attach, finish, url, id: hash, pageEvidence: raw => pageEvidence(raw, url), emit,
    targets: origins => { for (const origin of origins) { try { ports.add(Number(new URL(origin).port)) } catch { /* no raw URL in diagnostics */ } } },
    allowAssets: assets => { for (const asset of assets) if (/^[a-zA-Z0-9_.-]+$/.test(asset)) { allowedPaths.add('/crm/assets/' + asset); allowedPaths.add('/assets/' + asset) } },
    browserMetadata: (browser, version) => emit('browser', 'metadata', { chromium: /^[\d.]+$/.test(browser.version()) ? browser.version() : 'unknown', playwright: /^[\d.]+$/.test(version) ? version : 'unknown' }),
    stamp: () => ({ utc: clock.utc(), monotonic_ms: Number(clock.mono() - started) / 1e6 }),
  }
}
