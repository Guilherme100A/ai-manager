import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { VERSION, IMAGE, INDEX_DIGEST, resolvePackages, browserService, prepareBrowser, browserOrigin, controlEndpoint, connectBrowser, waitServerReady, closeBrowser, createSampler, runObserver, startBrowserObserver } from './nginx-browser-network-scope.mjs'
import { finishBeforeTeardown } from './nginx-network-diagnostic.mjs'

const secret = 'SYNTHETIC_R2_PRIVATE_TOKEN'
function packages(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci02-r2-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'); fs.mkdirSync(source)
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 }); fs.writeFileSync(file, value, { mode: 0o644 }) }
  write(path.join(source, 'package.json'), '{}')
  write(path.join(source, 'node_modules/@playwright/test/package.json'), JSON.stringify({ name: '@playwright/test', version: VERSION }))
  const pw = path.join(source, 'store/playwright'), core = path.join(source, 'store/playwright-core')
  write(path.join(pw, 'package.json'), JSON.stringify({ name: 'playwright', version: VERSION, dependencies: { 'playwright-core': VERSION } }))
  write(path.join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', version: VERSION }))
  write(path.join(pw, 'cli.js'), '// fixture CLI, never executed')
  fs.symlinkSync(pw, path.join(source, 'node_modules/playwright'), 'junction')
  fs.symlinkSync(core, path.join(source, 'node_modules/playwright-core'), 'junction')
  // Windows does not model POSIX directory execute bits. Exercise the Linux
  // permissions contract explicitly without weakening production validation.
  const io = { ...fs, lstatSync(file) { const stat = fs.lstatSync(file); if (process.platform === 'win32') stat.mode = (stat.mode & 0o170000) | (stat.isDirectory() ? 0o755 : 0o644); return stat } }
  return { root, source, pw, core, write, io, prepare: options => prepareBrowser(source, { ...options, packageOptions: { io } }) }
}
function runner() {
  const calls = [], evidence = []
  const run = (label, executable, args, options) => {
    calls.push({ label, executable, args, options })
    if (label === 'browser-image-inspect') return JSON.stringify({ Id: 'sha256:' + 'a'.repeat(64), RepoDigests: ['mcr.microsoft.com/playwright@' + INDEX_DIGEST], Os: 'linux', Architecture: 'amd64', Config: { Env: [secret] } })
    if (label === 'browser-index-inspect') return JSON.stringify({ manifests: [{ digest: 'sha256:' + 'b'.repeat(64), platform: { os: 'linux', architecture: 'amd64' } }] })
    if (label === 'browser-bind-validation') return JSON.stringify({ version: VERSION, core: VERSION, cli_resolved: true, browser_executable: true })
    if (label === 'browser-preflight-cleanup') return ''
    throw Error('unexpected mock command')
  }
  return { calls, evidence, run, emit: row => evidence.push(row) }
}
function child() {
  const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdin = new EventEmitter(); c.writes = []; c.kills = []
  c.kill = signal => { c.kills.push(signal); queueMicrotask(() => c.emit('close', null, signal)); return true }
  c.stdin.write = data => { c.writes.push(data); return true }; c.stdin.end = () => queueMicrotask(() => c.emit('close', 0, null))
  return c
}
function remoteSampler() {
  let ms = 0
  const sampler = createSampler({ io: { readlinkSync: () => 'net:[222]', readFileSync: () => secret + ' 10.1.2.3' }, interfaces: () => ({ [secret]: [{ address: '10.1.2.3', mac: secret }] }), utc: () => new Date(1700000000000 + ms).toISOString(), mono: () => BigInt(ms) * 1000000n, salt: 'fixture' })
  return { sampler, time: value => { ms = value } }
}

test('physical package directories resolve through existing links; only two packages plus observer are RO mounted', t => {
  const p = packages(t), resolved = resolvePackages(p.source, { io: p.io })
  assert.equal(resolved.playwright, fs.realpathSync(p.pw)); assert.equal(resolved.core, fs.realpathSync(p.core))
  const service = browserService(resolved)
  assert.equal(service.image, IMAGE); assert.equal(service.user, 'pwuser'); assert.equal(service.init, true)
  assert.equal(service.shm_size, '1gb'); assert.deepEqual(service.ports, ['127.0.0.1::3000'])
  assert.deepEqual(service.command, ['node', '/opt/ci-pw/node_modules/playwright/cli.js', 'run-server', '--host', '0.0.0.0', '--port', '3000'])
  assert.equal(service.volumes.length, 3); assert.ok(service.volumes.every(v => v.read_only && v.bind.create_host_path === false))
  assert.deepEqual(service.environment, { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' })
  for (const key of ['network_mode', 'ipc', 'pid', 'privileged', 'cap_add', 'devices']) assert.ok(!Object.hasOwn(service, key))
  assert.ok(service.volumes.every(v => v.source !== p.source && !v.source.includes('.env') && !v.source.includes('docker.sock')))
})
test('preflight pins index/platform/config identities separately and invokes one bind proof without download/build', t => {
  const p = packages(t), r = runner(), prepared = p.prepare(r)
  assert.equal(prepared.evidence.image_index_digest, INDEX_DIGEST)
  assert.equal(prepared.evidence.image_platform_digest, 'sha256:' + 'b'.repeat(64))
  assert.equal(prepared.evidence.image_id, 'sha256:' + 'a'.repeat(64))
  assert.equal(r.calls.filter(c => c.label === 'browser-bind-validation').length, 1)
  const proof = r.calls.find(c => c.label === 'browser-bind-validation')
  assert.equal(proof.options.timeout, 30000)
  assert.ok(proof.args.includes(IMAGE) && proof.args.includes('none') && proof.args.includes('pwuser'))
  assert.ok(!JSON.stringify(r.calls).includes('npx') && !JSON.stringify(r.calls).includes('npm install'))
  assert.ok(r.calls.every(c => c.executable === 'docker' && !c.args.includes('build')))
  assert.ok(!JSON.stringify(r.evidence).includes(secret))
})
for (const [name, change] of [
  ['version mismatch', p => p.write(path.join(p.pw, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.62.0', dependencies: { 'playwright-core': VERSION } }))],
  ['extra required dependency', p => p.write(path.join(p.pw, 'package.json'), JSON.stringify({ name: 'playwright', version: VERSION, dependencies: { 'playwright-core': VERSION, extra: '1' } }))],
  ['missing core', p => fs.unlinkSync(path.join(p.core, 'package.json'))],
]) test('bind strategy stops before Docker on ' + name, t => {
  const p = packages(t); change(p); const r = runner()
  assert.throws(() => p.prepare(r)); assert.equal(r.calls.length, 0)
  assert.equal(r.evidence.at(-1).no_fallback, true)
})
test('package symlink escapes and unreadable files are refused; no broadened mount', t => {
  const p = packages(t); const escaped = path.join(p.root, 'private'); fs.mkdirSync(escaped)
  fs.symlinkSync(escaped, path.join(p.pw, 'escape'), 'junction')
  assert.throws(() => resolvePackages(p.source, { io: p.io }), /bind_strategy_incompatible/)
  fs.unlinkSync(path.join(p.pw, 'escape'))
  const io = { ...p.io, lstatSync(file) { const stat = p.io.lstatSync(file); if (file.endsWith('cli.js')) stat.mode = 0o100600; return stat } }
  assert.throws(() => resolvePackages(p.source, { io }), /bind_not_readable_by_pwuser/)
})
test('failed bind proof preserves primary error/evidence, cleans only named container and never falls back', t => {
  const p = packages(t), r = runner(), primary = new Error('Step failed: browser-bind-validation')
  const run = (...args) => { if (args[0] === 'browser-bind-validation') { r.calls.push({ label: args[0], args: args[2] }); throw primary } return r.run(...args) }
  assert.throws(() => p.prepare({ run, emit: r.emit }), error => error === primary)
  const cleanup = r.calls.find(c => c.label === 'browser-preflight-cleanup')
  assert.deepEqual(cleanup.args.slice(0, 2), ['rm', '-f']); assert.match(cleanup.args[2], /^ci02-preflight-/)
  assert.equal(cleanup.options.timeout, 10000); assert.equal(r.evidence.at(-1).outcome, 'failed')
})
test('wrong image/index platform fails closed without inventing a platform digest', t => {
  const p = packages(t), r = runner()
  const run = (...args) => args[0] === 'browser-index-inspect' ? JSON.stringify({ manifests: [] }) : r.run(...args)
  assert.throws(() => p.prepare({ run, emit: r.emit }), /image_platform_unconfirmed/)
  assert.equal(r.evidence.at(-1).docker_validation_performed, false)
})
test('a different repository digest is refused before the bind proof, even with matching version/platform', t => {
  const p = packages(t), r = runner()
  const run = (...args) => args[0] === 'browser-image-inspect' ? JSON.stringify({ Id: 'sha256:' + 'a'.repeat(64), RepoDigests: ['mcr.microsoft.com/playwright@sha256:' + 'e'.repeat(64)], Os: 'linux', Architecture: 'amd64' }) : r.run(...args)
  assert.throws(() => p.prepare({ run, emit: r.emit }), /image_identity_mismatch/)
  assert.ok(!r.calls.some(c => c.label === 'browser-bind-validation'))
  assert.equal(r.evidence.at(-1).no_fallback, true)
})
test('runner HTTP origin and bridge browser origin are separate; connect API is single/no fallback/no CDP', async () => {
  assert.equal(browserOrigin(), 'http://dashboard')
  assert.equal(controlEndpoint('127.0.0.1:32770'), 'ws://127.0.0.1:32770/')
  assert.throws(() => controlEndpoint('0.0.0.0:3000'))
  let connects = 0, launches = 0
  const primary = new Error('connect failed')
  const chromium = { connect: async (endpoint, options) => { connects++; assert.equal(endpoint, 'ws://127.0.0.1:32770/'); assert.deepEqual(options, { timeout: 30000 }); throw primary }, launch: () => { launches++ }, connectOverCDP: () => { throw Error('forbidden') } }
  await assert.rejects(connectBrowser(chromium, controlEndpoint('127.0.0.1:32770')), error => error === primary)
  assert.equal(connects, 1); assert.equal(launches, 0)
})
test('server readiness uses a single passive log subscription and a bounded failure', async () => {
  const c = child(); let calls = 0
  const ready = waitServerReady('own-project', 'private-config', { launch(_exe, args) { calls++; assert.ok(args.includes('browser') && args.includes('--follow')); queueMicrotask(() => c.stdout.emit('data', Buffer.from('Listening on ws://0.0.0.0:3000/\n'))); return c }, timeoutMs: 50 })
  await ready; assert.equal(calls, 1); assert.deepEqual(c.kills, ['SIGTERM'])
  const unavailable = child()
  await assert.rejects(waitServerReady('own-project', 'private', { launch: () => unavailable, timeoutMs: 5 }), /readiness_timeout/)
  assert.ok(unavailable.kills.includes('SIGTERM'))
})
test('close timeout is own/bounded and cannot prevent observer, down and config cleanup', async () => {
  const order = [], primary = new Error('original timeout')
  await finishBeforeTeardown({ emit() {}, finish: async () => order.push('finish') }, [() => closeBrowser({ close: () => new Promise(() => {}) }, { timeoutMs: 5 }), () => { order.push('down'); throw Error('down failed') }, () => order.push('config-cleanup')], primary, [() => order.push('observer-stop')])
  assert.deepEqual(order, ['observer-stop', 'finish', 'down', 'config-cleanup'])
})
test('remote sampler has independent origin clock, namespaces, route/interface hashes, gaps and no raw secrets', () => {
  const r = remoteSampler(), before = r.sampler.sample('before'); r.time(100); const during = r.sampler.sample('during'); r.time(450); const gap = r.sampler.sample('during')
  assert.equal(before.scope, 'browser'); assert.equal(during.gap_ms, 100); assert.equal(gap.gap_ms, 350)
  assert.equal(before.namespace_id.length, 64); assert.equal(before.route_ids.length, 2)
  assert.ok(!JSON.stringify([before, during, gap]).includes(secret) && !JSON.stringify(gap).includes('10.1.2.3'))
  assert.equal(gap.transitions_between_samples_unobservable, true)
})
test('observer JSONL samples every 100ms, anchors request/response, bounds output and stops its own timer', () => {
  const r = remoteSampler(), input = new EventEmitter(), output = new EventEmitter(), rows = []; let tick, canceled = false
  input.resume = () => {}; input.pause = () => {}; output.write = line => { rows.push(JSON.parse(line)); return true }
  const collector = runObserver({ input, output, sampler: r.sampler, interval(fn, ms) { assert.equal(ms, 100); tick = fn; return 1 }, cancelInterval(token) { assert.equal(token, 1); canceled = true }, maxSamples: 2 })
  r.time(100); tick(); input.emit('data', Buffer.from('{"kind":"anchor","id":"a1"}\n')); r.time(200); tick(); r.time(300); tick(); collector.stop()
  assert.ok(rows.some(row => row.kind === 'anchor' && row.id === 'a1'))
  assert.equal(rows.at(-1).kind, 'end'); assert.equal(rows.at(-1).truncated, true); assert.ok(rows.at(-1).dropped > 0)
  assert.ok(canceled); assert.ok(rows.some(row => row.phase === 'after'))
})
test('runner records origin AND received clocks plus explicit anchor and distinct namespace proof', async () => {
  const c = child(), r = remoteSampler(), rows = []; let received = 0
  const diag = { stamp: () => ({ utc: '2026-11-22T19:00:00.000Z', monotonic_ms: ++received }), emit: (source, event, data) => rows.push({ source, event, ...data }) }
  c.stdin.write = data => { c.writes.push(data); const message = JSON.parse(data); if (message.kind === 'anchor') queueMicrotask(() => c.stdout.emit('data', Buffer.from(JSON.stringify(r.sampler.anchor(message.id)) + '\n'))); if (message.kind === 'stop') queueMicrotask(() => c.stdout.emit('data', Buffer.from(JSON.stringify(r.sampler.sample('after')) + '\n' + JSON.stringify(r.sampler.end({ truncated: false, dropped: 0, reason: 'requested_stop' })) + '\n'))); return true }
  const observer = startBrowserObserver('a'.repeat(64), diag, { launch: () => c, hostNamespace: 'f'.repeat(64), timeoutMs: 100 })
  queueMicrotask(() => c.stdout.emit('data', Buffer.from(JSON.stringify(r.sampler.sample('before')) + '\n')))
  await observer.ready; await observer.stop()
  const sample = rows.find(row => row.event === 'sample'), anchor = rows.find(row => row.event === 'anchor')
  assert.equal(sample.namespace_distinct, true); assert.ok(sample.origin_utc && sample.received.utc)
  assert.ok(anchor.runner_send.monotonic_ms < anchor.runner_receive.monotonic_ms)
  assert.equal(anchor.clock_mapping, 'request_response_anchor_no_shared_monotonic_epoch')
  assert.ok(c.writes.some(data => data.includes('stop')))
  assert.ok(rows.some(row => row.event === 'stopped' && row.availability === true))
  assert.ok(rows.some(row => row.anchor_id === 'a2'))
})
test('equal/unknown browser namespace or invalid remote data cannot establish readiness', async () => {
  const c = child(), r = remoteSampler(), sample = r.sampler.sample('before'), rows = []
  const observer = startBrowserObserver('a'.repeat(64), { stamp: () => ({}), emit: (_s, _e, data) => rows.push(data) }, { launch: () => c, hostNamespace: sample.namespace_id, timeoutMs: 50 })
  queueMicrotask(() => c.stdout.emit('data', Buffer.from(JSON.stringify(sample) + '\n')))
  await assert.rejects(observer.ready, /namespace_unconfirmed/); await observer.stop()
  assert.ok(rows.some(row => row.availability === false))
})
test('observer readiness/protocol failures are explicit and never start a second observer', async () => {
  const rows = [], c = child(); let launches = 0
  const diag = { stamp: () => ({}), emit: (_s, _e, data) => rows.push(data) }
  const observer = startBrowserObserver('a'.repeat(64), diag, { launch: () => { launches++; return c }, hostNamespace: 'f'.repeat(64), timeoutMs: 5 })
  await assert.rejects(observer.ready, /observer_timeout/); await observer.stop()
  assert.equal(launches, 1)
  const invalid = child(), other = startBrowserObserver('a'.repeat(64), diag, { launch: () => invalid, hostNamespace: 'f'.repeat(64), timeoutMs: 50 })
  queueMicrotask(() => invalid.stdout.emit('data', Buffer.from(secret + '\n')))
  await assert.rejects(other.ready, /namespace_unconfirmed/); await other.stop()
  assert.ok(!JSON.stringify(rows).includes(secret))
})
test('unresponsive owned observer is bounded at cleanup, failure stays diagnostic, down still runs', async () => {
  const c = child(), r = remoteSampler(), rows = [], order = []
  const diag = { stamp: () => ({ utc: '2026-11-22T19:00:00.000Z', monotonic_ms: 1 }), emit: (_s, event, data) => rows.push({ event, ...data }), finish: async () => order.push('finish') }
  c.stdin.write = data => { const message = JSON.parse(data); if (message.kind === 'anchor') queueMicrotask(() => c.stdout.emit('data', Buffer.from(JSON.stringify(r.sampler.anchor(message.id)) + '\n'))); return true }
  c.stdin.end = () => {}; c.kill = signal => { c.kills.push(signal); return true }
  const observer = startBrowserObserver('a'.repeat(64), diag, { launch: () => c, hostNamespace: 'f'.repeat(64), timeoutMs: 50, stopTimeoutMs: 5 })
  queueMicrotask(() => c.stdout.emit('data', Buffer.from(JSON.stringify(r.sampler.sample('before')) + '\n')))
  await observer.ready
  const primary = new Error('primary visibility timeout')
  await finishBeforeTeardown(diag, [() => order.push('close'), () => order.push('down'), () => order.push('config')], primary, [observer.stop])
  assert.ok(c.kills.includes('SIGKILL')); assert.ok(rows.some(row => row.reason === 'observer_stop_timeout' && row.availability === false))
  assert.deepEqual(order, ['finish', 'close', 'down', 'config'])
})
test('collector stream failure is sanitized, rejects readiness and still permits owned cleanup', async () => {
  const c = child(), rows = []
  const observer = startBrowserObserver('a'.repeat(64), { stamp: () => ({}), emit: (_s, _e, data) => rows.push(data) }, { launch: () => c, hostNamespace: 'f'.repeat(64), timeoutMs: 50 })
  queueMicrotask(() => c.stdout.emit('error', new Error(secret)))
  await assert.rejects(observer.ready, /observer_unavailable/); await observer.stop()
  assert.ok(rows.some(row => row.reason === 'observer_output_unavailable' && row.availability === false))
  assert.ok(!JSON.stringify(rows).includes(secret))
})
test('R2 harness keeps HTTP gates on runner, browser requests on bridge, and no package/build/network bypass', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url)), source = fs.readFileSync(path.join(dir, 'nginx-ci.mjs'), 'utf8')
  assert.ok(source.indexOf('await diagnostic.collectVersions()') < source.indexOf("diagnostic.operation('compose_up'"))
  assert.ok(source.includes("[[backend, ''], [dashboard, '/crm']]"))
  assert.ok(source.includes("page.goto(browserDashboard + '/crm/welcome')"))
  assert.ok(source.includes("route.continue({ url: browserDashboard + '/crm/assets/missing-t004-d02.js' })"))
  assert.ok(!source.includes('chromium.launch(') && !source.includes('connectOverCDP') && !source.includes('exposeNetwork'))
})
