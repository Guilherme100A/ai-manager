import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createDiagnostic, dockerEvent, linkEvent, errorEvidence, mimeEvidence, composeLogEvidence, privateComposeConfig, finishBeforeTeardown } from './nginx-network-diagnostic.mjs'
import { waitForVisibleWithEvidence, captureBrowserFailure, hasFailureEvidence } from './nginx-browser-evidence.mjs'

const secret = 'SYNTHETIC_PRIVATE_TOKEN_9z'
const here = path.dirname(fileURLToPath(import.meta.url))
function fixture(options = {}) {
  const rows = [], calls = [], children = []
  let tick = 0
  const launch = (exe, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kills = []
    child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true }
    children.push(child); calls.push({ exe, args })
    queueMicrotask(() => {
      if (options.noIp && exe === 'ip') { child.emit('error', Error(secret)); return }
      child.emit('spawn')
      if (exe === 'ip' || args[0] === 'events') return
      let output = ''
      if (args.includes('ps')) output = 'a'.repeat(64) + '\n'
      else if (args[0] === 'inspect') output = JSON.stringify({ Status: 'running', Health: { Status: 'healthy', Log: [{ Output: secret }] } }) + '\t0\t' + JSON.stringify({ [secret]: { NetworkID: 'b'.repeat(64) } })
      else output = options.secretVersion ? secret : '29.8.2\n'
      child.stdout.emit('data', Buffer.from(output)); child.emit('close', 0, null)
    })
    return child
  }
  const diagnostic = createDiagnostic({ project: 'fixture-project', composeFile: 'private-config-not-logged',
    env: { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'c'.repeat(40), RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: options.badRunner ? secret : 'ubuntu26', ImageVersion: '20261116.202.1', PRIVATE_TOKEN: secret },
    clock: { utc: () => new Date(1700000000000 + tick).toISOString(), mono: () => BigInt(tick++) * 1000000n },
    io: { readFileSync: file => file.includes('operstate') ? 'up\n' : secret + ' private-route 10.24.35.1' },
    sink: line => rows.push(JSON.parse(line)), launch, salt: 'test-only-salt', ...options,
  })
  const page = new EventEmitter(), browser = new EventEmitter(), frame = { url: () => 'http://127.0.0.1:32769/crm/welcome?token=' + secret }
  browser.version = () => '153.0.8010.12'
  page.mainFrame = () => frame
  const request = (address, navigation = false, owner = frame) => ({ url: () => address, isNavigationRequest: () => navigation, frame: () => owner, resourceType: () => navigation ? 'document' : 'script', failure: () => ({ errorText: 'net::ERR_NETWORK_CHANGED ' + secret }) })
  return { diagnostic, rows, calls, children, page, browser, frame, request }
}
const turns = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }

test('one Node clock, ordered seq/UTC/monotonic and failures before first welcome wait', async () => {
  const f = fixture(), errors = []; f.diagnostic.start()
  const events = f.diagnostic.attach(f.page, f.browser, errors)
  const document = f.request(f.frame.url(), true)
  f.page.emit('request', document)
  for (const name of ['one.js', 'two.js', 'three.js']) f.page.emit('requestfailed', f.request('http://127.0.0.1:32769/crm/assets/' + name))
  await f.diagnostic.operation('wait_packaged-welcome', async () => {})
  await f.diagnostic.finish()
  const failures = f.rows.filter(r => r.event === 'requestfailed'), wait = f.rows.find(r => r.operation === 'wait_packaged-welcome')
  assert.ok(failures.length > 1)
  assert.ok(failures.every(r => r.seq < wait.seq && r.nav_id === 'n1' && r.frame_id === 'f1' && /^r\d+$/.test(r.request_id)))
  assert.equal(new Set(failures.map(r => r.request_id)).size, failures.length)
  for (let i = 1; i < f.rows.length; i++) { assert.ok(f.rows[i].seq > f.rows[i - 1].seq); assert.ok(f.rows[i].monotonic_ms >= f.rows[i - 1].monotonic_ms); assert.ok(Date.parse(f.rows[i].utc) >= Date.parse(f.rows[i - 1].utc)) }
  assert.ok(f.rows.every(r => r.run_id === '123' && r.run_attempt === '2' && r.SHA === 'c'.repeat(40) && r.phase === 'nginx'))
  assert.equal(events.pageErrors.length, 0)
  assert.equal(events.responses.length, 0)
})

test('request identity survives response/failure and independent frame navigations', async () => {
  const f = fixture(); f.diagnostic.attach(f.page, f.browser, [])
  const first = f.request(f.frame.url(), true); f.page.emit('request', first)
  const secondFrame = { url: () => 'https://private.example/' + secret }
  f.page.emit('request', f.request(secondFrame.url(), true, secondFrame))
  f.page.emit('framenavigated', f.frame)
  const asset = f.request('http://127.0.0.1:32769/crm/assets/index.js')
  f.page.emit('request', asset)
  f.page.emit('response', { request: () => asset, status: () => 200, headers: () => ({ 'content-type': 'application/javascript; charset=utf-8', 'set-cookie': secret }) })
  f.page.emit('requestfailed', asset)
  const related = f.rows.filter(r => r.request_id === f.rows.at(-1).request_id)
  assert.deepEqual(related.map(r => r.event), ['request', 'response', 'requestfailed'])
  assert.ok(related.every(r => r.nav_id === 'n1' && r.frame_id === 'f1'))
  assert.equal(related[1].mime, 'application/javascript')
  await f.diagnostic.finish()
})
test('early navigation without an available frame still has a unique navigation/request identity', async () => {
  const f = fixture(); f.diagnostic.attach(f.page, f.browser, [])
  const request = { ...f.request(f.frame.url(), true), frame() { throw Error(secret) } }
  f.page.emit('request', request); f.page.emit('requestfailed', request)
  const records = f.rows.filter(r => r.request_id)
  assert.ok(records.every(r => r.nav_id === 'n1' && r.frame_id === 'none' && r.frame_unavailable))
  assert.equal(new Set(records.map(r => r.request_id)).size, 1)
  assert.ok(!JSON.stringify(records).includes(secret))
  await f.diagnostic.finish()
})

test('allowlist excludes tokens/cookies/query/fragment/private paths, console and raw infra payloads', async () => {
  const f = fixture({ secretVersion: true, badRunner: true }); f.diagnostic.start()
  const events = f.diagnostic.attach(f.page, f.browser, [])
  f.diagnostic.allowAssets(['index-fixture.js'])
  f.page.emit('requestfailed', f.request('http://user:' + secret + '@127.0.0.1:32769/crm/assets/' + secret + '.js?cookie=' + secret + '#' + secret))
  f.page.emit('requestfailed', f.request('file:///home/private/' + secret))
  f.page.emit('console', { type: () => 'error', text: () => 'Authorization: Bearer ' + secret })
  f.page.emit('pageerror', new Error('/home/private/' + secret))
  f.page.emit('framenavigated', { url: () => 'https://private.example/' + secret })
  f.diagnostic.browserMetadata(f.browser, '1.58.0')
  await turns()
  f.children[0].stdout.emit('data', Buffer.from('[2026-11-22T18:24:28Z] 7: private-iface: state DOWN ' + secret + ' 10.24.35.1\n'))
  f.children[1].stdout.emit('data', Buffer.from(JSON.stringify({ Type: 'network', Action: 'connect', time: 1700000000, Actor: { ID: secret, Attributes: { 'com.docker.compose.project': 'fixture-project', token: secret } } }) + '\n'))
  f.diagnostic.snapshot('compose_ready')
  await f.diagnostic.finish()
  const safe = JSON.stringify({ rows: f.rows, events, page: f.diagnostic.pageEvidence({ url: f.frame.url(), frame_urls: ['https://private.example/' + secret], title: secret, readyState: 'complete', body: secret, root: '<div token="' + secret + '">' + secret + '</div>' }) })
  for (const text of [secret, 'private.example', 'private-iface', '10.24.35.1', '/home/private/', 'set-cookie', 'Bearer']) assert.ok(!safe.includes(text), text)
  assert.ok(f.rows.some(r => r.source === 'link' && r.event === 'change'))
  assert.ok(f.rows.some(r => r.source === 'docker' && r.event === 'change' && r.project_scoped))
  assert.ok(f.rows.some(r => r.event === 'snapshot' && r.health === 'healthy' && r.restarts === 0))
  assert.equal(f.diagnostic.url('http://127.0.0.1:32769/crm/assets/index-fixture.js?x=' + secret), 'http://loopback:32769/crm/assets/index-fixture.js')
  assert.equal(mimeEvidence(secret + '/private'), 'other')
})

test('Docker/link projections simulate transitions, omit third-party payload and make no causal claim', () => {
  const hash = () => 'opaque-id'
  const own = dockerEvent({ Type: 'container', Action: 'restart', Actor: { ID: secret, Attributes: { 'com.docker.compose.project': 'fixture-project', secret } }, time: 1700000000 }, 'fixture-project', hash)
  assert.equal(own.project_scoped, true); assert.equal(own.action, 'restart')
  const outside = dockerEvent({ Type: 'network', Action: 'create', Actor: { ID: secret, Attributes: { secret } } }, 'fixture-project', hash)
  assert.deepEqual(outside, { type: 'network', action: 'create', project_scoped: false, outside_project_count: 1 })
  assert.equal(dockerEvent({ Type: 'container', Action: 'create', Actor: { ID: secret } }, 'fixture-project', hash), null)
  const link = linkEvent('Deleted 4: ' + secret + ': state DOWN inet 10.24.35.1', hash)
  assert.equal(link.state, 'down'); assert.equal(link.source_time_unavailable, true)
  assert.ok(!JSON.stringify({ own, outside, link }).includes(secret))
})
test('timestamp-only monitor line is an anchor, not an invented route change', async () => {
  const f = fixture(); f.diagnostic.start(); await turns()
  f.children[0].stdout.emit('data', Buffer.from('Timestamp: 2026-11-22T18:24:28Z\n8: private: state UP\n'))
  await f.diagnostic.finish()
  const links = f.rows.filter(r => r.source === 'link' && r.event === 'change')
  assert.equal(links.length, 1)
  assert.equal(links[0].source_utc, '2026-11-22T18:24:28.000Z')
})
test('Compose log projection is bounded and omits raw addresses/query/cookies/messages', () => {
  const f = fixture()
  const raw = `dashboard-1 | 2026-11-22T18:24:28.123Z 10.24.35.1 "GET /crm/welcome?token=${secret} HTTP/1.1" 200 42 "Cookie:${secret}"\ncrm-api-1 | 2026-11-22T18:24:28Z Authorization: Bearer ${secret}\nthird-party-1 | ${secret}\n`
  const text = composeLogEvidence(raw.repeat(30), f.diagnostic.url, 4096)
  assert.ok(!text.includes(secret) && !text.includes('10.24.35.1') && !text.includes('Cookie'))
  assert.ok(text.includes('http://loopback/crm/welcome'))
  assert.ok(Buffer.byteLength(text) <= 4096)
  assert.equal(JSON.parse(text.trim().split('\n').at(-1)).truncated, true)
})

test('unsupported monitor reports unavailable, remaining owned collectors stop, never asserts stable network', async () => {
  const f = fixture({ noIp: true }); f.diagnostic.start(); await turns(); await f.diagnostic.finish()
  assert.equal(f.rows.at(-1).availability.link, false)
  assert.ok(f.children[1].kills.includes('SIGTERM'))
  assert.ok(!JSON.stringify(f.rows).includes('network_stable'))
  assert.ok(f.calls.every(c => (c.exe === 'ip' && c.args.includes('monitor')) || (c.exe === 'docker' && ['events', 'version', 'compose', 'inspect'].includes(c.args[0]))))
})
test('owned monitor that ignores termination is bounded and reports its stop timeout', async () => {
  const f = fixture(); f.diagnostic.start(); await turns()
  f.children[0].kill = signal => { f.children[0].kills.push(signal); return true }
  await f.diagnostic.finish()
  assert.ok(f.children[0].kills.includes('SIGTERM') && f.children[0].kills.includes('SIGKILL'))
  assert.ok(f.rows.some(r => r.event === 'stop_timeout' && r.collector === 'link'))
  assert.ok(f.children[1].kills.includes('SIGTERM'))
})

test('bounded incremental timeline and browser histories retain drop counts and safe cause', async () => {
  const f = fixture({ maxBytes: 8192, maxEvents: 12 })
  const events = f.diagnostic.attach(f.page, f.browser, [])
  for (let i = 0; i < 400; i++) f.page.emit('requestfailed', f.request('http://127.0.0.1:32769/private-' + secret + '/' + i))
  assert.ok(f.rows.length > 0, 'records flush before finish')
  assert.ok(events.failedRequests.length <= 256 && events.dropped > 0)
  await f.diagnostic.finish()
  assert.equal(f.rows.at(-1).truncated, true)
  assert.ok(f.rows.at(-1).dropped > 0)
  assert.ok(f.rows.at(-1).truncation_reasons.includes('timeline_limit'))
  assert.ok(Buffer.byteLength(f.rows.map(r => JSON.stringify(r) + '\n').join('')) <= 8192)
})

test('diagnostic I/O failure is contained and does not convert an operation error/success', async () => {
  const f = fixture({ sink: () => { throw Error(secret) } })
  const primary = Object.assign(new Error('locator.waitFor: Timeout 30000ms exceeded'), { name: 'TimeoutError' })
  await assert.rejects(f.diagnostic.operation('wait_packaged-welcome', async () => { throw primary }), error => error === primary)
  assert.equal(f.diagnostic.operation('http_probe', () => 200), 200)
  await f.diagnostic.finish()
  assert.deepEqual(errorEvidence(primary), { name: 'TimeoutError', message: primary.message })
})
test('wrapper status is success 0 or explicitly unavailable; failed Compose called once and error unchanged', async () => {
  const f = fixture(), primary = new Error('Step failed: disposable-nginx-up')
  let calls = 0
  assert.throws(() => f.diagnostic.operation('compose_up', () => { calls++; throw primary }), error => error === primary)
  assert.equal(calls, 1)
  const failed = f.rows.at(-1)
  assert.equal(failed.source, 'wrapper'); assert.equal(failed.outcome, 'failed')
  assert.equal(failed.exitCode, null); assert.equal(failed.exit_status_unavailable, true)
  assert.equal(failed.signal, null); assert.equal(failed.signal_unavailable, true)
  assert.equal(failed.timeout, null); assert.equal(failed.timeout_unavailable, true)
  f.diagnostic.operation('compose_up', () => 'compose stdout')
  assert.equal(f.rows.at(-1).exitCode, 0)
  assert.equal(f.rows.at(-1).exit_status_unavailable, false)
  const cleanup = []
  await finishBeforeTeardown(f.diagnostic, [() => cleanup.push('evidence'), () => cleanup.push('down')], primary)
  assert.deepEqual(cleanup, ['evidence', 'down'])
})
test('private Compose config is outside upload trees; cleanup runs after down failure and cannot mask primary', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci02-private-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), report = path.join(root, 'crm-reports')
  fs.mkdirSync(source); fs.mkdirSync(report)
  const config = privateComposeConfig(source, JSON.stringify({ private: secret }))
  assert.ok(!config.file.startsWith(report + path.sep))
  assert.ok(!config.file.startsWith(path.join(source, 'test-results', 'T004-D01') + path.sep))
  if (process.platform !== 'win32') assert.equal(fs.statSync(config.file).mode & 0o777, 0o600)
  const f = fixture(), primary = new Error('primary timeout')
  await finishBeforeTeardown(f.diagnostic, [() => { throw Error('down failed') }, config.cleanup, () => { throw Error('cleanup failed too') }], primary)
  assert.equal(fs.existsSync(config.file), false)
  assert.equal(fs.existsSync(path.dirname(config.file)), false)
  assert.deepEqual(fs.readdirSync(report), [])
})

test('timeout remains unchanged, evidence/PNG/timeline collected before close/down even if one collector fails', async t => {
  const report = fs.mkdtempSync(path.join(os.tmpdir(), 'ci02-evidence-'))
  t.after(() => fs.rmSync(report, { recursive: true, force: true }))
  const f = fixture(), order = [], primary = Object.assign(new Error('locator.waitFor: Timeout 30000ms exceeded'), { name: 'TimeoutError' })
  f.page.locator = () => ({ waitFor: async (...args) => { assert.deepEqual(args, []); order.push('wait'); throw primary } })
  f.page.evaluate = async () => ({ url: f.frame.url(), readyState: 'complete', title: 'CRM', body: '', root: '' })
  f.page.frames = () => [f.frame]
  f.page.screenshot = async ({ path: file }) => { order.push('screenshot'); fs.writeFileSync(file, 'synthetic fixture PNG') }
  const events = f.diagnostic.attach(f.page, f.browser, [])
  f.page.emit('requestfailed', f.request(f.frame.url()))
  f.diagnostic.snapshot = () => { throw Error(secret) }
  const run = async () => {
    let caught
    try { await waitForVisibleWithEvidence(f.page, '[data-testid="page-welcome"]', report, 'packaged-welcome', events, f.diagnostic) }
    catch (error) { caught = error; throw error }
    finally { await finishBeforeTeardown(f.diagnostic, [() => { order.push('close'); throw Error('close fixture failure') }, () => order.push('down')], caught) }
  }
  await assert.rejects(run(), error => error === primary)
  const evidence = JSON.parse(fs.readFileSync(path.join(report, 'packaged-welcome-failure.json'), 'utf8'))
  assert.equal(evidence.infra_unavailable, true)
  assert.equal(evidence.page.root, '')
  assert.ok(evidence.utc && evidence.monotonic_ms >= 0)
  assert.ok(fs.existsSync(path.join(report, 'packaged-welcome-failure.png')))
  assert.ok(!JSON.stringify(evidence).includes(secret))
  assert.deepEqual(order, ['wait', 'screenshot', 'close', 'down'])
  assert.equal(f.rows.at(-1).event, 'collection_end')
})

test('teardown isolates every diagnostic/close/log failure and preserves primary error', async () => {
  const order = [], primary = new Error('primary')
  await finishBeforeTeardown({ emit() { throw Error(secret) }, async finish() { order.push('finish'); throw Error(secret) } }, [() => { order.push('close'); throw Error(secret) }, () => { order.push('logs'); throw Error(secret) }, () => order.push('down')], primary)
  assert.deepEqual(order, ['finish', 'close', 'logs', 'down'])
})
test('early goto failure creates bounded evidence and never overwrites existing artifacts', async t => {
  const report = fs.mkdtempSync(path.join(os.tmpdir(), 'ci02-early-'))
  t.after(() => fs.rmSync(report, { recursive: true, force: true }))
  const f = fixture(), events = f.diagnostic.attach(f.page, f.browser, [])
  f.page.evaluate = async () => ({ url: f.frame.url(), frame_urls: [], title: 'CRM', readyState: 'complete', body: secret, root: '<div token="' + secret + '">private</div>' })
  f.page.screenshot = async ({ path: file }) => fs.writeFileSync(file, 'fixture PNG')
  const old = path.join(report, 'early-failure.json'); fs.writeFileSync(old, 'preserve prior evidence')
  const primary = new Error('net::ERR_NETWORK_CHANGED ' + secret)
  await captureBrowserFailure(f.page, '[before-visibility]', report, 'early', events, primary, f.diagnostic)
  assert.equal(hasFailureEvidence(primary), true)
  assert.equal(fs.readFileSync(old, 'utf8'), 'preserve prior evidence')
  const created = fs.readdirSync(report).filter(n => n.endsWith('.json') && n !== 'early-failure.json')
  assert.equal(created.length, 1)
  const evidence = fs.readFileSync(path.join(report, created[0]), 'utf8')
  assert.ok(!evidence.includes(secret))
  for (const name of ['pageErrors', 'consoleErrors', 'failedRequests', 'failedResponses', 'responses']) assert.deepEqual(JSON.parse(evidence).events[name], [])
  await f.diagnostic.finish()
})
test('oversized owned screenshot is omitted with explicit drop count, primary timeout preserved', async t => {
  const report = fs.mkdtempSync(path.join(os.tmpdir(), 'ci02-png-limit-'))
  t.after(() => fs.rmSync(report, { recursive: true, force: true }))
  const primary = Object.assign(new Error('locator.waitFor: Timeout 30000ms exceeded'), { name: 'TimeoutError' })
  const page = { locator: () => ({ waitFor: async () => { throw primary } }), evaluate: async () => ({ url: '', readyState: 'complete', title: 'CRM', body: '', root: '' }), screenshot: async ({ path: file }) => fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1)) }
  await assert.rejects(waitForVisibleWithEvidence(page, 'fixture', report, 'oversized', { pageErrors: [], failedRequests: [], responses: [] }), error => error === primary)
  const evidence = JSON.parse(fs.readFileSync(path.join(report, 'oversized-failure.json'), 'utf8'))
  assert.equal(evidence.screenshot_truncated, true)
  assert.ok(evidence.screenshot_dropped_bytes > 8 * 1024 * 1024)
  assert.equal(fs.existsSync(path.join(report, 'oversized-failure.png')), false)
})

test('healthy gate source retains original HTTP/MIME/no-store/paint/recovery assertions and limits', () => {
  const source = fs.readFileSync(path.join(here, 'nginx-ci.mjs'), 'utf8')
  for (const invariant of ["compose('up', '-d', '--wait', '--wait-timeout', '180')", "await capture('packaged-welcome', 'page-welcome')", "await capture('packaged-recovered', 'page-flows')", "assert.equal(policy, 'no-store'", 'assert.equal(response.status, status, url)', 'assert.match(type, mime, url)', 'assert.ok(paint.width > 0 && paint.height > 0 && paint.uncovered && paint.shell)', 'assert.deepEqual(pageErrors, []', "assert.equal(documents - before, 2, 'retry must not loop or reload')", 'assert.equal(documents - before, 3)']) assert.ok(source.includes(invariant), invariant)
  assert.ok(!source.includes('setDefaultTimeout') && !source.includes('waitForTimeout') && !source.includes('net-log'))
  assert.ok(source.indexOf('diagnostic.start()') < source.indexOf("diagnostic.operation('compose_up'"))
})
test('DIAG01 both version probes settle once before a real >2s synchronous Compose block', async () => {
  const rows = [], trace = [], active = new Set()
  const timers = { setTimeout(fn, ms) { assert.equal(ms, 2000); const token = setTimeout(() => { active.delete(token); trace.push('timeout'); fn() }, ms); active.add(token); return token }, clearTimeout(token) { active.delete(token); clearTimeout(token) } }
  const launch = (exe, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true }
    if (exe === 'ip' || args[0] === 'events') { trace.push('monitor'); return child }
    trace.push('probe')
    setImmediate(() => { child.stdout.emit('data', Buffer.from('29.8.2\n')); trace.push('probe_done'); child.emit('close', 0, null) })
    return child
  }
  const diag = createDiagnostic({ launch, probeTimers: timers, sink: line => rows.push(JSON.parse(line)) })
  diag.start(); await diag.collectVersions(); await diag.collectVersions()
  assert.equal(trace.filter(x => x === 'monitor').length, 2)
  assert.equal(trace.filter(x => x === 'probe').length, 2)
  assert.equal(trace.filter(x => x === 'probe_done').length, 2)
  assert.equal(active.size, 0)
  const primary = new Error('Step failed: disposable-nginx-up'); let composeCalls = 0
  assert.throws(() => diag.operation('compose_up', () => {
    composeCalls++; trace.push('compose')
    const start = performance.now(); while (performance.now() - start < 2050) { /* deliberate event-loop block */ }
    throw primary
  }), error => error === primary)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(composeCalls, 1)
  assert.equal(trace.includes('timeout'), false)
  assert.ok(trace.lastIndexOf('probe_done') < trace.indexOf('compose'))
  assert.equal(rows.filter(r => r.event === 'version').length, 2)
  assert.ok(!rows.some(r => r.reason === 'probe_timeout'))
  await diag.finish()
})
test('DIAG01 genuinely unresponsive children hit the unchanged 2s limit; Compose is not repeated', async () => {
  const rows = [], calls = []
  const launch = (_exe, args) => {
    calls.push(args); const child = new EventEmitter(); child.stdout = new EventEmitter()
    child.kill = signal => { queueMicrotask(() => child.emit('close', null, signal)); return true }
    return child
  }
  const diag = createDiagnostic({ launch, sink: line => rows.push(JSON.parse(line)) })
  await diag.collectVersions(); await diag.collectVersions()
  assert.equal(calls.length, 2)
  assert.equal(rows.filter(r => r.reason === 'probe_timeout').length, 2)
  let composeCalls = 0; diag.operation('compose_up', () => { composeCalls++; return 'ok' })
  assert.equal(composeCalls, 1)
  assert.ok(!JSON.stringify(rows).includes('docker_absent'))
  await diag.finish()
})
