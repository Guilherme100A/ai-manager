import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parsePolicy, readPolicy, thresholds, guard, command } from './deploy-disk.mjs'

const policy = { format: 1, observed_peak_bytes: 0, observed_peak_inodes: 0 }
const home = path.resolve('mock-home')
const file = path.join(home, '.config/ai-manager/deploy-disk.json')
const repo = path.resolve('mock-repo'), docker = path.resolve('mock-docker')
const secret = 'SYNTHETIC_SECRET_DO_NOT_LOG'
function fixture() {
  const f = { present: false, text: JSON.stringify(policy), calls: [], logs: [], separate: false, pruned: false, healthy: false, recover: true, bad: {}, env: {} }
  const stat = (dir = false) => ({ uid: 1000, mode: dir ? 0o40700 : 0o100600, dev: 1, ino: 2, size: Buffer.byteLength(f.text), mtimeMs: 1, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false })
  const failure = code => { throw Object.assign(new Error(secret), { code }) }
  f.io = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 131072, O_NONBLOCK: 2048 },
    lstatSync(p) {
      if (p === file) { if (!f.present) failure('ENOENT'); if (f.unreadable) failure('EACCES'); return { ...stat(), ...f.bad.file } }
      return { ...stat(true), ...f.bad.ancestor }
    },
    openSync(_p, flags) { assert.ok(flags & 131072); if (f.openError) failure('EACCES'); return 9 },
    fstatSync() { return { ...stat(), ...f.bad.opened } },
    readSync(_fd, buffer) { return buffer.write(f.text) },
    closeSync() { f.closed = true },
    realpathSync(p) { if (f.pathError) failure('ENOENT'); return p },
    statSync(p) { return { ...stat(true), dev: f.separate && p === docker ? 2 : 1 } },
  }
  f.run = (exe, args, timeout) => {
    f.calls.push({ exe, args, timeout })
    const key = args.join(' ')
    if (f.probeError && key.includes(f.probeError)) return { status: 17, stderr: secret }
    let stdout = ''
    if (exe === 'df') {
      const ready = f.healthy || (f.pruned && f.recover)
      const bytes = f.bytes ?? (ready ? 10 * 2 ** 30 : 1)
      const inode = f.inodes ?? 400000
      stdout = `Avail Inodes IAvail\n${f.separate && args.at(-1) === docker && f.dockerLow ? 1 : bytes} ${f.total ?? 2000000} ${inode}\n`
      if (f.badMeasurement) stdout = f.badMeasurement
    } else if (key === 'context show') stdout = f.context ?? 'default'
    else if (key.includes('context inspect')) stdout = JSON.stringify(f.endpoint ?? 'unix:///var/run/docker.sock')
    else if (key.includes('buildx inspect')) stdout = JSON.stringify({ Name: 'default', Driver: f.driver ?? 'docker', Nodes: [{ Endpoint: f.nodeEndpoint ?? 'default', Status: 'running' }] })
    else if (key.includes('compose build --help')) stdout = f.noBuilder ? '' : '--builder string'
    else if (key.includes('info --format')) stdout = JSON.stringify(docker)
    else if (key.includes('prune --help')) return f.noPrune ? { status: 1, stderr: secret } : { status: 0, stdout: '--all --force' }
    else if (key.includes('builder prune --all --force')) {
      f.pruned = true
      if (f.pruneFailure) return { ...f.pruneFailure, stderr: secret, stdout: secret }
    } else throw Error('Unexpected mock command')
    return { status: 0, stdout }
  }
  f.go = () => {
    const code = guard({ repo, env: f.env, uid: 1000, home, io: f.io, run: f.run, log: row => f.logs.push(row) })
    const logs = JSON.stringify(f.logs)
    for (const forbidden of [secret, repo, docker, home]) assert.ok(!logs.includes(forbidden))
    for (const call of f.calls) {
      if (call.args.includes('prune') && !call.args.includes('--help')) assert.deepEqual(call.args, ['--context', 'default', 'builder', 'prune', '--all', '--force'])
      assert.ok(!['system', 'image', 'volume', 'container', 'context use', 'down'].some(word => call.args.includes(word)))
    }
    return code
  }
  f.prunes = () => f.calls.filter(c => c.args.join(' ').includes('prune --all --force'))
  return f
}

test('policy exact defaults, valid file and fixed threshold boundaries', () => {
  const f = fixture()
  assert.deepEqual(readPolicy(file, { io: f.io, uid: 1000 }), { source: 'defaults', policy })
  f.present = true
  assert.deepEqual(readPolicy(file, { io: f.io, uid: 1000 }), { source: 'file', policy })
  assert.equal(f.closed, true)
  assert.deepEqual(thresholds(policy, 2000000), { min_free_bytes: 6442450944, min_free_inodes: 100000 })
  assert.equal(thresholds(policy, 2000001).min_free_inodes, 100001)
  assert.deepEqual(thresholds({ ...policy, observed_peak_bytes: 8 * 2 ** 30, observed_peak_inodes: 200000 }, 2000000), { min_free_bytes: 10 * 2 ** 30, min_free_inodes: 225000 })
})
for (const text of [
  'null', '[]', '{}', '{"format":1,"observed_peak_bytes":0,"observed_peak_inodes":0,"extra":0}',
  '{"format":1,"format":1,"observed_peak_bytes":0,"observed_peak_inodes":0}',
  '{"format":1,"observed_peak_bytes":0,"observed_peak_\\u0062ytes":0,"observed_peak_inodes":0}',
  ...['"0"', '-1', '0.1', '1.0', '1e0', 'null', '9007199254740992', '9007197107257343'].map(n => `{"format":1,"observed_peak_bytes":${n},"observed_peak_inodes":0}`),
  '{"format":1,"observed_peak_bytes":0,"observed_peak_inodes":9007199254715991}',
  '{"format":1.0,"observed_peak_bytes":0,"observed_peak_inodes":0}',
]) test('invalid policy rejected: ' + text.slice(0, 70), () => { assert.throws(() => parsePolicy(text)); const f = fixture(); f.present = true; f.text = text; assert.equal(f.go(), 5); assert.equal(f.calls.length, 0) })

for (const [name, setup] of [
  ['owner', f => { f.bad.file = { uid: 99 } }],
  ['mode', f => { f.bad.file = { mode: 0o100644 } }],
  ['special mode', f => { f.bad.file = { mode: 0o104600 } }],
  ['symlink', f => { f.bad.file = { isSymbolicLink: () => true } }],
  ['not regular', f => { f.bad.file = { isFile: () => false } }],
  ['oversize', f => { f.text += ' '.repeat(4097) }],
  ['ancestor writable', f => { f.bad.ancestor = { mode: 0o40722 } }],
  ['ancestor wrong owner', f => { f.bad.ancestor = { uid: 99 } }],
  ['ancestor symlink', f => { f.bad.ancestor = { isSymbolicLink: () => true } }],
  ['dedicated directory mode', f => { f.bad.ancestor = { mode: 0o40755 } }],
  ['unreadable', f => { f.unreadable = true }],
  ['open unreadable', f => { f.openError = true }],
  ['changed inode', f => { f.bad.opened = { ino: 3 } }],
  ['changed opened mode', f => { f.bad.opened = { mode: 0o100666 } }],
]) test('policy security refuses ' + name, () => { const f = fixture(); f.present = true; setup(f); assert.equal(f.go(), 5); assert.equal(f.calls.length, 0); assert.ok(!JSON.stringify(f.logs).includes(secret)) })
test('absent policy still rejects unsafe ancestors and relative override', () => {
  const f = fixture(); f.bad.ancestor = { mode: 0o40777 }; assert.equal(f.go(), 5)
  const g = fixture(); g.env.AI_MANAGER_DISK_POLICY = 'relative.json'; assert.equal(g.go(), 5)
  const h = fixture(); h.env.AI_MANAGER_DISK_POLICY = path.join(repo, 'deploy-disk.json'); assert.equal(h.go(), 5)
})
test('secure .config 0755/root-owned ancestors accepted, max 4096 bytes accepted', () => {
  const f = fixture(); f.present = true; f.text += ' '.repeat(4096 - f.text.length)
  const original = f.io.lstatSync
  f.io.lstatSync = p => {
    const s = original(p)
    if (p !== file && path.basename(p) !== 'ai-manager') { s.uid = 0; s.mode = 0o40755 }
    return s
  }
  assert.equal(readPolicy(file, { io: f.io, uid: 1000 }).source, 'file')
})
test('changing ancestor after open rejected and descriptor closed', () => {
  const f = fixture(); f.present = true; let opened = false
  const originalOpen = f.io.openSync, originalLstat = f.io.lstatSync
  f.io.openSync = (...args) => { opened = true; return originalOpen(...args) }
  f.io.lstatSync = p => ({ ...originalLstat(p), ...(opened ? { ino: 9 } : {}) })
  assert.equal(f.go(), 5); assert.equal(f.closed, true)
})

test('healthy default gate: dedupe same filesystem, no prune, all probes bounded', () => {
  const f = fixture(); f.healthy = true; assert.equal(f.go(), 0)
  assert.equal(f.calls.filter(c => c.exe === 'df').length, 1)
  assert.equal(f.prunes().length, 0)
  assert.equal(f.logs.find(r => r.phase === 'before').filesystem_scope, 'shared')
  assert.ok(f.calls.every(c => c.timeout === 15000))
})
test('exact floors pass; warning below 8 GiB does not block; alert boundary exact', () => {
  const f = fixture(); f.bytes = 6442450944; f.inodes = 100000; assert.equal(f.go(), 0)
  assert.equal(f.logs.find(r => r.phase === 'before').alert, true)
  f.bytes = 8589934592; f.logs = []; assert.equal(f.go(), 0)
  assert.equal(f.logs.find(r => r.phase === 'before').alert, false)
})
test('measured peak increases budget; one byte or inode below floor cannot build', () => {
  for (const change of [f => { f.bytes = 6442450943 }, f => { f.inodes = 99999 }, f => { f.present = true; f.text = JSON.stringify({ ...policy, observed_peak_bytes: 12 * 2 ** 30 }); f.bytes = 13 * 2 ** 30 }]) {
    const f = fixture(); f.healthy = true; change(f); assert.equal(f.go(), 5); assert.equal(f.prunes().length, 0)
  }
})
test('two filesystems independently measured, never sum; low Docker FS blocks', () => {
  const f = fixture(); f.separate = true; f.healthy = true; f.dockerLow = true
  assert.equal(f.go(), 5); assert.equal(f.calls.filter(c => c.exe === 'df').length, 2)
  assert.deepEqual(f.logs.filter(r => r.phase === 'before').map(r => r.filesystem_scope), ['repo', 'docker'])
})
for (const [name, change] of [
  ['inodes absent', f => { f.badMeasurement = 'Avail Inodes IAvail\n99999999999 - -' }],
  ['inodes total zero', f => { f.total = 0 }],
  ['unsafe measurement', f => { f.bytes = Number.MAX_SAFE_INTEGER + 1 }],
  ['invalid measurement', f => { f.badMeasurement = secret }],
  ['root directory missing', f => { f.pathError = true }],
  ['wrong context', f => { f.context = 'remote' }],
  ['remote endpoint', f => { f.endpoint = 'tcp://private:2376' }],
  ['wrong driver', f => { f.driver = 'docker-container' }],
  ['wrong node', f => { f.nodeEndpoint = 'remote' }],
  ['Compose no builder', f => { f.noBuilder = true }],
  ['failed probe', f => { f.probeError = 'info' }],
  ['failed measurement', f => { f.probeError = '--output' }],
  ...['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'BUILDX_BUILDER', 'COMPOSE_BAKE', 'COMPOSE_FILE'].map(k => [k, f => { f.env[k] = secret }]),
  ['legacy build', f => { f.env.DOCKER_BUILDKIT = '0' }],
]) test('gate blocks before prune: ' + name, () => { const f = fixture(); f.healthy = true; change(f); assert.equal(f.go(), 5); assert.equal(f.prunes().length, 0); assert.ok(!JSON.stringify(f.logs).includes(secret)) })

test('one restricted prune recovers, then rechecks all filesystems', () => {
  const f = fixture(); f.separate = true; f.env.AI_MANAGER_BUILDER_LOCK_CONFIRMED = '1'
  assert.equal(f.go(), 0); assert.equal(f.prunes().length, 1)
  assert.deepEqual(f.prunes()[0], { exe: 'docker', args: ['--context', 'default', 'builder', 'prune', '--all', '--force'], timeout: 120000 })
  assert.equal(f.calls.filter(c => c.exe === 'df').length, 4)
  const prune = f.calls.indexOf(f.prunes()[0])
  assert.equal(f.calls.slice(0, prune).filter(c => c.exe === 'df').length, 2)
  assert.equal(f.calls.slice(prune + 1).filter(c => c.exe === 'df').length, 2)
})
test('one prune insufficient: fail with no retry', () => { const f = fixture(); f.recover = false; f.env.AI_MANAGER_BUILDER_LOCK_CONFIRMED = '1'; assert.equal(f.go(), 5); assert.equal(f.prunes().length, 1) })
for (const healthy of [true, false]) test('prune unavailable ' + (healthy ? 'warns above floor' : 'fails below floor'), () => { const f = fixture(); f.healthy = healthy; f.noPrune = true; assert.equal(f.go(), healthy ? 0 : 5); assert.equal(f.prunes().length, 0) })
for (const result of [{ status: 18 }, { status: null, signal: 'SIGTERM' }, { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } }]) test('prune failure/timeout never masked by recovered space: ' + JSON.stringify(result), () => {
  const f = fixture(); f.env.AI_MANAGER_BUILDER_LOCK_CONFIRMED = '1'; f.pruneFailure = result
  assert.equal(f.go(), 5); assert.equal(f.prunes().length, 1)
  assert.ok(f.logs.some(r => r.phase === 'after'))
  assert.equal(f.logs.at(-1).reason, 'prune_failed')
  assert.ok(!JSON.stringify(f.logs).includes(secret))
})
test('operational confirmation absent blocks only prune; concurrent report overrides confirmation', () => {
  const f = fixture(); assert.equal(f.go(), 5); assert.equal(f.prunes().length, 0)
  f.healthy = true; assert.equal(f.go(), 0)
  const g = fixture(); g.env.AI_MANAGER_BUILDER_LOCK_CONFIRMED = '1'; g.env.AI_MANAGER_BUILD_CONCURRENT = '1'
  assert.equal(g.go(), 5); assert.equal(g.prunes().length, 0); assert.equal(g.logs.at(-1).reason, 'concurrent_build')
})
test('real command timeout is bounded, retains ETIMEDOUT and signal without echoing output', () => {
  const r = command(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], 50)
  assert.equal(r.error?.code, 'ETIMEDOUT')
  assert.equal(r.status, null)
  assert.ok(r.signal)
})
test('log capture failure cannot mask a primary error or permit build/prune', () => {
  for (const healthy of [true, false]) {
    const f = fixture(); f.healthy = healthy; f.env.AI_MANAGER_BUILDER_LOCK_CONFIRMED = '1'
    assert.equal(guard({ repo, env: f.env, uid: 1000, home, io: f.io, run: f.run, log: () => { throw Error(secret) } }), 5)
    assert.equal(f.prunes().length, 0)
  }
})
