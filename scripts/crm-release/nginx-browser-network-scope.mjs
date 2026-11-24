import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const VERSION = '1.63.0'
export const INDEX_DIGEST = 'sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
export const IMAGE = `mcr.microsoft.com/playwright:v${VERSION}-noble@${INDEX_DIGEST}`
const ROOT = '/opt/ci-pw'
const sha = value => createHash('sha256').update(String(value)).digest('hex')
const check = (ok, code) => { if (!ok) throw Object.assign(new Error('CI02 ' + code), { code }) }
const inside = (root, candidate) => { const r = path.relative(root, candidate); return r === '' || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '')
export const namespaceId = (io = fs) => sha(io.readlinkSync('/proc/self/ns/net'))

export function resolvePackages(source, { io = fs, requireFrom = createRequire } = {}) {
  try {
    const approved = io.realpathSync(source)
    const testJson = requireFrom(path.join(approved, 'package.json')).resolve('@playwright/test/package.json')
    const playwrightJson = requireFrom(testJson).resolve('playwright/package.json')
    const coreJson = requireFrom(playwrightJson).resolve('playwright-core/package.json')
    const files = [testJson, playwrightJson, coreJson]
    const manifests = files.map(file => JSON.parse(io.readFileSync(file, 'utf8')))
    check(manifests.every((m, i) => m.version === VERSION && m.name === ['@playwright/test', 'playwright', 'playwright-core'][i]), 'package_version_mismatch')
    check(Object.keys(manifests[1].dependencies ?? {}).length === 1 && manifests[1].dependencies['playwright-core'] === VERSION && Object.keys(manifests[2].dependencies ?? {}).length === 0, 'bind_strategy_incompatible')
    const packages = files.slice(1).map(file => io.realpathSync(path.dirname(file)))
    for (const dir of packages) {
      check(inside(approved, dir), 'bind_outside_approved_source')
      const stack = [dir]
      while (stack.length) {
        const item = stack.pop(), stat = io.lstatSync(item)
        check(!stat.isSymbolicLink(), 'bind_strategy_incompatible')
        check(stat.isDirectory() ? (stat.mode & 0o005) === 0o005 : stat.isFile() && (stat.mode & 0o004) === 0o004, 'bind_not_readable_by_pwuser')
        if (stat.isDirectory()) for (const name of io.readdirSync(item)) stack.push(path.join(item, name))
      }
    }
    check(files.every(file => inside(approved, io.realpathSync(file))), 'bind_outside_approved_source')
    return { playwright: packages[0], core: packages[1], version: VERSION }
  } catch (error) { if (error.code?.startsWith('bind_') || error.code === 'package_version_mismatch') throw error; throw Object.assign(new Error('CI02 package_resolution_failed'), { code: 'package_resolution_failed' }) }
}
export function browserService(packages, observerFile = fileURLToPath(import.meta.url)) {
  return { image: IMAGE, pull_policy: 'never', init: true, user: 'pwuser', shm_size: '1gb', stop_grace_period: '10s',
    ports: ['127.0.0.1::3000'], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    environment: { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
    command: ['node', ROOT + '/node_modules/playwright/cli.js', 'run-server', '--host', '0.0.0.0', '--port', '3000'],
    volumes: [
      { type: 'bind', source: packages.playwright, target: ROOT + '/node_modules/playwright', read_only: true, bind: { create_host_path: false } },
      { type: 'bind', source: packages.core, target: ROOT + '/node_modules/playwright-core', read_only: true, bind: { create_host_path: false } },
      { type: 'bind', source: observerFile, target: ROOT + '/observe.mjs', read_only: true, bind: { create_host_path: false } },
    ] }
}
const validationCode = `const fs=require('fs'),p=require('${ROOT}/node_modules/playwright'),v=require('${ROOT}/node_modules/playwright/package.json').version,c=require('${ROOT}/node_modules/playwright-core/package.json').version;require('${ROOT}/node_modules/playwright/lib/program.js');fs.accessSync(p.chromium.executablePath(),fs.constants.R_OK|fs.constants.X_OK);fs.accessSync('${ROOT}/observe.mjs',fs.constants.R_OK);if(v!=='${VERSION}'||c!=='${VERSION}')process.exit(2);console.log(JSON.stringify({version:v,core:c,cli_resolved:true,browser_executable:true}))`
export function prepareBrowser(source, { run, emit = () => {}, observerFile, packageOptions } = {}) {
  let step = 'packages', validationName
  const evidence = { mode: 'container', expected_version: VERSION, image_index_digest: INDEX_DIGEST, docker_validation_performed: false }
  const publish = data => { try { emit(data) } catch { /* metadata I/O never replaces a preflight error */ } }
  try {
    const packages = resolvePackages(source, packageOptions), service = browserService(packages, observerFile)
    step = 'image_inspect'
    const image = JSON.parse(run('browser-image-inspect', 'docker', ['image', 'inspect', IMAGE, '--format', '{{json .}}']))
    check(digest(image.Id) && image.Os === 'linux' && image.Architecture === 'amd64' && image.RepoDigests?.includes('mcr.microsoft.com/playwright@' + INDEX_DIGEST), 'image_identity_mismatch')
    step = 'index_inspect'
    const index = JSON.parse(run('browser-index-inspect', 'docker', ['manifest', 'inspect', IMAGE]))
    const platform = index.manifests?.filter(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64')
    check(platform?.length === 1 && digest(platform[0].digest), 'image_platform_unconfirmed')
    Object.assign(evidence, { image_id: image.Id, image_platform_digest: platform[0].digest, platform: 'linux/amd64', repo_digest: 'mcr.microsoft.com/playwright@' + INDEX_DIGEST })
    step = 'bind_validation'
    validationName = 'ci02-preflight-' + process.pid + '-' + randomBytes(4).toString('hex')
    const mounts = service.volumes.flatMap(v => ['--mount', `type=bind,source=${v.source},target=${v.target},readonly`])
    check(service.volumes.every(v => !/[,\r\n]/.test(v.source)), 'bind_strategy_incompatible')
    const validated = JSON.parse(run('browser-bind-validation', 'docker', ['run', '--rm', '--name', validationName, '--network', 'none', '--init', '--user', 'pwuser', '--shm-size', '1gb', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ...mounts, '--entrypoint', 'node', IMAGE, '-e', validationCode], { timeout: 30000 }))
    validationName = undefined
    check(validated.version === VERSION && validated.core === VERSION && validated.cli_resolved === true && validated.browser_executable === true, 'bind_strategy_incompatible')
    Object.assign(evidence, { outcome: 'pass', docker_validation_performed: true, package_version: VERSION })
    publish(evidence)
    return { service, evidence }
  } catch (error) {
    if (validationName) { try { run('browser-preflight-cleanup', 'docker', ['rm', '-f', validationName], { timeout: 10000 }) } catch { /* only the named preflight container; preserve primary */ } }
    publish({ ...evidence, outcome: 'failed', step, reason: ['package_version_mismatch', 'bind_strategy_incompatible', 'bind_not_readable_by_pwuser', 'bind_outside_approved_source', 'image_identity_mismatch', 'image_platform_unconfirmed', 'package_resolution_failed'].includes(error.code) ? error.code : 'preflight_failed', no_fallback: true })
    throw error
  }
}
export const browserOrigin = () => 'http://dashboard'
export function controlEndpoint(port) {
  check(/^127\.0\.0\.1:\d{1,5}$/.test(port) && Number(port.split(':')[1]) > 0 && Number(port.split(':')[1]) <= 65535, 'browser_control_endpoint_invalid')
  return 'ws://' + port + '/'
}
export async function connectBrowser(chromium, endpoint) {
  check(/^ws:\/\/127\.0\.0\.1:\d+\/$/.test(endpoint), 'browser_control_endpoint_invalid')
  return chromium.connect(endpoint, { timeout: 30000 }) // Never connectOverCDP/exposeNetwork/host fallback.
}
export function waitServerReady(project, composeFile, { launch = spawn, timeoutMs = 30000, stopTimeoutMs = 250 } = {}) {
  return new Promise((resolve, reject) => {
    let child, text = '', bytes = 0, done = false, closed = false, closeResolve
    const closure = new Promise(resolveClosed => { closeResolve = resolveClosed })
    const ignore = () => {}
    const onChildError = () => end(new Error('CI02 browser_readiness_unavailable'))
    const onStreamError = () => end(new Error('CI02 browser_readiness_unavailable'))
    const onClose = () => { closed = true; closeResolve(); if (!done) end(new Error('CI02 browser_server_ended')) }
    const release = () => {
      child?.removeListener('close', onClose)
      child?.removeListener('error', onChildError)
      child?.on('error', ignore) // Late process/pipe errors cannot replace readiness.
      child?.stdout?.removeListener('error', onStreamError)
      child?.stdout?.on('error', ignore)
      try { child?.stdout?.destroy?.() } catch { /* only the owned log pipe */ }
      try { child?.unref?.() } catch { /* no global process or service is signalled */ }
    }
    const stop = async () => {
      if (!child || closed) return
      try { child.kill('SIGTERM') } catch { /* still enforce the bounded escalation */ }
      let stopTimer
      try {
        await Promise.race([closure, new Promise(stopped => {
          stopTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* own child may already have exited */ }; stopped() }, stopTimeoutMs)
        })])
      } finally { clearTimeout(stopTimer) }
    }
    const end = error => {
      if (done) return
      done = true; clearTimeout(timer)
      child?.stdout?.removeListener('data', onData)
      try { child?.stdout?.pause?.() } catch { /* queued callbacks also check done */ }
      text = ''; bytes = 0
      // Keep the first readiness result, but settle only after close or the
      // existing R1-style TERM grace + KILL of this single owned subscriber.
      stop().then(() => { release(); error ? reject(error) : resolve() })
    }
    const onData = chunk => {
      if (done) return
      try {
        const incoming = chunk.toString(), size = Buffer.byteLength(incoming)
        if (bytes + size > 65536) return end(new Error('CI02 browser_readiness_limit'))
        bytes += size; text += incoming
        if (/Listening on ws:\/\/(?:0\.0\.0\.0|\[::\]|localhost):3000\//.test(text)) end()
      } catch { end(new Error('CI02 browser_readiness_unavailable')) }
    }
    const timer = setTimeout(() => end(new Error('CI02 browser_readiness_timeout')), timeoutMs)
    try {
      child = launch('docker', ['compose', '-p', project, '-f', composeFile, 'logs', '--follow', '--no-color', 'browser'], { stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.on('data', onData)
      child.stdout.on('error', onStreamError)
      child.on('error', onChildError)
      child.once('close', onClose)
    } catch { end(new Error('CI02 browser_readiness_unavailable')) }
  })
}
export async function closeBrowser(browser, { timeoutMs = 10000 } = {}) {
  if (!browser) return
  let timer
  try { await Promise.race([browser.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CI02 browser_close_timeout')), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

// The same standalone file is mounted RO in the browser container. Its observer
// uses only Node built-ins, never reads environ/argv/application files.
export function createSampler({ io = fs, interfaces = os.networkInterfaces, utc = () => new Date().toISOString(), mono = () => process.hrtime.bigint(), salt = randomBytes(16).toString('hex') } = {}) {
  const start = mono(); let seq = 0, previous
  const stamp = () => ({ origin_seq: ++seq, origin_utc: utc(), origin_monotonic_ms: Number(mono() - start) / 1e6 })
  const sample = phase => {
    const row = { kind: 'sample', scope: 'browser', phase, ...stamp(), sample_interval_ms: 100, transitions_between_samples_unobservable: true }
    row.gap_ms = previous === undefined ? null : row.origin_monotonic_ms - previous; previous = row.origin_monotonic_ms
    try {
      row.namespace_id = namespaceId(io)
      row.links = Object.entries(interfaces()).slice(0, 64).map(([name, addresses]) => ({ id: sha(salt + name), topology_id: sha(salt + JSON.stringify((addresses ?? []).map(a => JSON.stringify(a)).sort())), addresses: (addresses ?? []).length })).sort((a, b) => a.id.localeCompare(b.id))
      row.route_ids = ['/proc/net/route', '/proc/net/ipv6_route'].map(file => sha(salt + io.readFileSync(file, 'utf8')))
      row.availability = true
    } catch { row.availability = false; row.reason = 'browser_network_snapshot_unavailable' }
    return row
  }
  return { sample, anchor: id => ({ kind: 'anchor', id, scope: 'browser', ...stamp() }), end: data => ({ kind: 'end', scope: 'browser', ...stamp(), ...data }) }
}
export function runObserver({ input = process.stdin, output = process.stdout, sampler = createSampler(), interval = setInterval, cancelInterval = clearInterval, maxBytes = 1024 * 1024, maxSamples = 3000 } = {}) {
  let bytes = 0, samples = 0, dropped = 0, stopped = false, buffer = '', timer
  const write = row => { const text = JSON.stringify(row) + '\n'; if (bytes + Buffer.byteLength(text) > maxBytes - 1024) { dropped++; return false }; bytes += Buffer.byteLength(text); output.write(text); return true }
  const stop = (truncated = false, reason = 'requested_stop') => {
    if (stopped) return; stopped = true; cancelInterval(timer)
    const after_snapshot_available = write(sampler.sample('after'))
    output.write(JSON.stringify(sampler.end({ truncated: truncated || dropped > 0, dropped, reason, sampling_attempts: samples, after_snapshot_available })) + '\n')
    input.removeListener('data', receive); input.pause?.(); input.unref?.()
  }
  const receive = chunk => {
    buffer += chunk
    if (buffer.length > 4096) return stop(true, 'observer_input_limit')
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      try { const message = JSON.parse(line); if (message.kind === 'stop') stop(); else if (message.kind === 'anchor' && /^a\d+$/.test(message.id) && !write(sampler.anchor(message.id))) stop(true, 'observer_output_limit') } catch { stop(true, 'observer_protocol_invalid') }
      if (stopped) break
    }
  }
  input.on('data', receive); input.once('end', () => stop()); input.resume?.()
  write(sampler.sample('before'))
  timer = interval(() => { if (++samples > maxSamples) { dropped++; stop(true, 'observer_output_limit') } else if (!write(sampler.sample('during'))) stop(true, 'observer_output_limit') }, 100)
  output.once?.('error', () => { stopped = true; cancelInterval(timer); input.pause?.(); input.unref?.() })
  return { stop }
}

export function startBrowserObserver(container, diagnostic, { launch = spawn, hostNamespace, timeoutMs = 30000, stopTimeoutMs = 10000 } = {}) {
  if (hostNamespace === undefined) { try { hostNamespace = namespaceId() } catch { check(false, 'host_namespace_unavailable') } }
  check(/^[a-f0-9]{12,64}$/.test(container) && /^[a-f0-9]{64}$/.test(hostNamespace), 'browser_container_unconfirmed')
  const container_id = diagnostic.id?.(container) ?? null
  const child = launch('docker', ['exec', '-i', container, 'node', ROOT + '/observe.mjs', '--observe'], { stdio: ['pipe', 'pipe', 'ignore'] })
  let buffer = '', lastSeq = 0, namespace, readyDone = false, readyAccepted = false, ended = false, stopRequested = false, endReceived = false, coverageIncomplete = false, stopResolve, lines = 0, receiverDropped = 0
  const anchors = new Map()
  const closed = new Promise(resolve => { stopResolve = resolve })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (!readyDone) { readyDone = true; reject(new Error('CI02 browser_observer_timeout')) } }, timeoutMs)
    const accept = () => { if (!readyDone) { readyDone = true; readyAccepted = true; clearTimeout(timer); resolve() } }
    child.stdout.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const split = buffer.indexOf('\n'); if (split < 0) break
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1)
        if (++lines > 5000 || line.length > 65536) { coverageIncomplete = true; receiverDropped++; diagnostic.emit('browser_namespace', 'unavailable', { availability: false, reason: 'observer_receiver_limit', truncated: true, dropped: receiverDropped }); if (!readyDone) { readyDone = true; clearTimeout(timer); reject(new Error('CI02 browser_observer_limit')) } continue }
        try {
          const raw = JSON.parse(line)
          check(['sample', 'anchor', 'end'].includes(raw.kind) && Number.isSafeInteger(raw.origin_seq) && raw.origin_seq > lastSeq && Number.isFinite(raw.origin_monotonic_ms) && raw.origin_monotonic_ms >= 0 && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(raw.origin_utc) && Number.isFinite(Date.parse(raw.origin_utc)), 'observer_projection_invalid')
          const origin_records_gap = raw.origin_seq - lastSeq - 1
          lastSeq = raw.origin_seq
          const row = { scope: 'browser', container_id, origin_seq: raw.origin_seq, origin_records_gap, origin_utc: raw.origin_utc, origin_monotonic_ms: raw.origin_monotonic_ms, received: diagnostic.stamp() }
          if (raw.kind === 'sample') {
            check(raw.availability === true && /^[a-f0-9]{64}$/.test(raw.namespace_id) && raw.namespace_id !== hostNamespace && Array.isArray(raw.route_ids) && raw.route_ids.length === 2 && raw.route_ids.every(x => /^[a-f0-9]{64}$/.test(x)), 'browser_namespace_unconfirmed')
            namespace = raw.namespace_id
            Object.assign(row, { namespace_id: namespace, host_namespace_id: hostNamespace, namespace_distinct: true, availability: true, phase: ['before', 'during', 'after'].includes(raw.phase) ? raw.phase : 'unknown', sampling_interval_ms: 100, gap_ms: Number.isFinite(raw.gap_ms) && raw.gap_ms >= 0 ? raw.gap_ms : null, transitions_between_samples_unobservable: true, links: (raw.links ?? []).slice(0, 64).filter(x => /^[a-f0-9]{64}$/.test(x.id) && /^[a-f0-9]{64}$/.test(x.topology_id) && Number.isSafeInteger(x.addresses) && x.addresses >= 0).map(x => ({ id: x.id, topology_id: x.topology_id, addresses: x.addresses })), route_ids: (raw.route_ids ?? []).filter(x => /^[a-f0-9]{64}$/.test(x)).slice(0, 2) })
            if (!anchors.has('a1')) { anchors.set('a1', diagnostic.stamp()); child.stdin.write('{"kind":"anchor","id":"a1"}\n') }
          } else if (raw.kind === 'anchor') {
            check(['a1', 'a2'].includes(raw.id) && anchors.has(raw.id) && namespace, 'observer_anchor_invalid')
            Object.assign(row, { anchor_id: raw.id, runner_send: anchors.get(raw.id), runner_receive: row.received, clock_mapping: 'request_response_anchor_no_shared_monotonic_epoch' }); if (raw.id === 'a1') accept()
          } else { endReceived = true; coverageIncomplete ||= raw.truncated === true || raw.dropped > 0; Object.assign(row, { truncated: raw.truncated === true, dropped: Number.isSafeInteger(raw.dropped) && raw.dropped >= 0 ? raw.dropped : null, reason: ['requested_stop', 'observer_input_limit', 'observer_protocol_invalid', 'observer_output_limit'].includes(raw.reason) ? raw.reason : 'observer_ended' }) }
          diagnostic.emit('browser_namespace', raw.kind, row)
        } catch { coverageIncomplete = true; diagnostic.emit('browser_namespace', 'unavailable', { availability: false, reason: 'observer_projection_or_namespace_invalid' }); if (!readyDone) { readyDone = true; clearTimeout(timer); reject(new Error('CI02 browser_namespace_unconfirmed')) } }
      }
      if (buffer.length > 65536) { buffer = ''; coverageIncomplete = true; receiverDropped++; diagnostic.emit('browser_namespace', 'unavailable', { availability: false, reason: 'observer_line_limit', truncated: true, dropped: receiverDropped }); if (!readyDone) { readyDone = true; clearTimeout(timer); reject(new Error('CI02 browser_observer_limit')) } }
    })
    child.once('error', () => { clearTimeout(timer); if (!readyDone) { readyDone = true; reject(new Error('CI02 browser_observer_unavailable')) } })
    child.stdout.on('error', () => { coverageIncomplete = true; diagnostic.emit('browser_namespace', 'unavailable', { availability: false, reason: 'observer_output_unavailable' }); clearTimeout(timer); if (!readyDone) { readyDone = true; reject(new Error('CI02 browser_observer_unavailable')) } })
    child.stdin.on('error', () => { coverageIncomplete = true; diagnostic.emit('browser_namespace', 'unavailable', { availability: false, reason: 'observer_input_unavailable' }); clearTimeout(timer); if (!readyDone) { readyDone = true; reject(new Error('CI02 browser_observer_unavailable')) } })
    child.once('close', () => { clearTimeout(timer); ended = true; stopResolve(); const complete = stopRequested && endReceived && readyAccepted && !coverageIncomplete; diagnostic.emit('browser_namespace', complete ? 'stopped' : 'ended', { availability: complete, active: false, reason: complete ? 'requested_stop_complete' : 'observer_closed_or_partial' }); if (!readyDone) { readyDone = true; reject(new Error('CI02 browser_observer_ended')) } })
  })
  const stop = async () => {
    if (ended) return
    stopRequested = true
    try {
      if (namespace) { anchors.set('a2', diagnostic.stamp()); child.stdin.write('{"kind":"anchor","id":"a2"}\n') }
      child.stdin.write('{"kind":"stop"}\n'); child.stdin.end()
    } catch { /* container cleanup still follows */ }
    let timer
    try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { diagnostic.emit('browser_namespace', 'unavailable', { availability: false, reason: 'observer_stop_timeout' }); child.kill('SIGKILL'); reject(new Error('CI02 browser_observer_stop_timeout')) }, stopTimeoutMs) })]) } finally { clearTimeout(timer) }
  }
  // Caller owns teardown even when ready rejects; no second observer/fallback.
  return { ready, stop }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === '--observe') runObserver()
