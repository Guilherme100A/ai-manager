import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { deploy } from './deploy.mjs'
import { invoke } from './compose.mjs'
import { TREE, sha, hashFile, read, override, specFor, composeArgs, secrets, validateManifest, availableMemoryBytes } from './lib.mjs'
import { pgClientPlan, pg16Versions } from './pg-client-ci.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))
const revision = 'a'.repeat(40), image = 'sha256:' + 'b'.repeat(64)
test('Linux memory budget distinguishes reclaimable cache from a real shortage and falls back conservatively', () => {
  assert.equal(availableMemoryBytes('MemFree: 100000 kB\nMemAvailable: 1400000 kB\n', 100000 * 1024), 1400000 * 1024)
  assert.equal(availableMemoryBytes('MemAvailable: 100000 kB\n', 900000 * 1024), 100000 * 1024)
  for (const text of [undefined, '', 'MemAvailable: -1 kB', 'MemAvailable: nope kB', 'MemAvailable: 1 kB\nMemAvailable: 2 kB', 'MemAvailable: 99999999999999999999 kB']) assert.equal(availableMemoryBytes(text, 123), 123)
})
test('explicit activation uses the same canonical company in API and worker without changing mounts', () => {
  const spec = specFor({ release: revision, image_id: image }, 'preserved_storage')
  const company = '11111111-1111-4111-8111-111111111111'
  const disabled = override(spec), enabled = override({ ...spec, company_id: company })
  assert.equal(enabled.split(company).length - 1, 2)
  assert.equal(enabled.replaceAll(JSON.stringify(company), "''"), disabled)
})
test('activation refuses malformed, ambiguous and non-string company targets', () => {
  const spec = specFor({ release: revision, image_id: image }, 'preserved_storage')
  for (const company_id of [null, true, [], 'ai-manager', ' 11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222']) assert.throws(() => override({ ...spec, company_id }), /Invalid activation company/)
})
test('activated company persists through the next compose call and unauthorized override drift is refused', t => {
  const f = fixture(t), spec = { ...f.spec, company_id: '11111111-1111-4111-8111-111111111111' }
  const dir = path.join(f.state, 'releases', revision)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(f.state, 'active.json'), JSON.stringify(spec))
  const file = path.join(dir, 'override.yml')
  fs.writeFileSync(file, override(spec))
  assert.equal(composeArgs(f.repo, f.state).at(-1), file)
  fs.writeFileSync(file, override(f.spec))
  assert.throws(() => composeArgs(f.repo, f.state), /Persistent override drift/)
})
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mock-only-'))
  t.after(() => { const resolved = path.resolve(root); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'crm-mock-only-')); fs.rmSync(resolved, { recursive: true }) })
  const repo = path.join(root, 'repo'), state = path.join(root, 'state'), artifact = path.join(root, 'artifact'), legacy = path.join(root, 'legacy')
  for (const dir of [repo, artifact, legacy, path.join(repo, 'scripts/crm-release')]) fs.mkdirSync(dir, { recursive: true })
  for (const f of ['.env', 'docker-compose.yml', 'docker-compose.crm.yml']) fs.writeFileSync(path.join(repo, f), 'mock only\n')
  fs.copyFileSync(path.join(here, 'entrypoint.sh'), path.join(repo, 'scripts/crm-release/entrypoint.sh'))
  fs.writeFileSync(path.join(repo, 'scripts/deploy-vps.sh'), '#!/bin/sh\n# mock persistent driver\n')
  fs.writeFileSync(path.join(legacy, 'tracked.ts'), 'representative source\n')
  fs.writeFileSync(path.join(root, 'deploy-ai-manager.sh'), 'previous bootstrap')
  for (const f of ['images.tar.gz', 'spa.tar.gz']) fs.writeFileSync(path.join(artifact, f), 'mock artifact ' + f)
  const m = { format: 1, release: revision, source_tree: TREE, image: 'crm-shared-offers:' + revision, image_id: image, runtime: 'node:22-alpine', platform: 'linux/amd64', images_sha256: hashFile(path.join(artifact, 'images.tar.gz')), spa_sha256: hashFile(path.join(artifact, 'spa.tar.gz')), migrations: Array.from({ length: 44 }, (_, i) => ({ idx: i, when: 1000 + i, tag: i >= 39 ? ['0039_shared_offers', '0040_offer_delivery_recovery', '0041_offer_block_push', '0042_offer_tenant_scope', '0043_business_areas'][i - 39] : 'old_' + i, hash: sha('migration ' + i) })) }
  fs.writeFileSync(path.join(artifact, 'release.json'), JSON.stringify(m))
  const receipt = { observed_at: new Date().toISOString(), approved_panel_sha: revision, legacy_crm: legacy, crm_head: 'c'.repeat(40), source_sha256: sha(JSON.stringify([['tracked.ts', sha('representative source\n')]])), storage_volume: 'preserved_storage', required_free_bytes: 1, ack_shared_database_rpo: true }
  const receiptFile = path.join(root, 'receipt.json'), saveReceipt = () => fs.writeFileSync(receiptFile, JSON.stringify(receipt)); saveReceipt()
  const env = { ...Object.fromEntries(secrets.map(k => [k, 'fake-' + k])), WA_GATEWAY: 'rpc', WA_RPC_PROFILE: 'ai-manager', WA_RPC_URL: 'http://worker:9465', WA_EVENTS_STREAM: 'wsm:events', CRM_QUEUE_PREFIX: 'crm', SHARED_OFFERS_COMPANY_ID: '' }
  const before = { services: { 'crm-api': { environment: env }, 'crm-worker': { environment: env }, postgres: { environment: { POSTGRES_USER: 'test', POSTGRES_DB: 'test' } } } }
  const spec = specFor(m, 'preserved_storage')
  const after = { services: { 'crm-api': { image, environment: { ...env }, command: ['node', '/crm/node_modules/tsx/dist/cli.mjs', '--conditions=development', '/crm/apps/api/src/server.ts'], volumes: [{ source: 'deps', target: '/crm/node_modules', read_only: true }, { source: 'storage', target: '/data/storage' }] }, 'crm-worker': { image, environment: { ...env }, command: ['node', '/crm/node_modules/tsx/dist/cli.mjs', '--conditions=development', '/crm/apps/worker/src/main.ts'], volumes: [{ source: 'deps', target: '/crm/node_modules', read_only: true }, { source: 'storage', target: '/data/storage' }] }, 'crm-web': { volumes: [{ source: 'spa', target: '/usr/share/nginx/html' }] }, 'crm-web-build': { image, command: ['cp', '-a', '/crm/apps/web/dist/.', '/out/'], volumes: [{ source: 'spa', target: '/out' }] } }, volumes: { deps: { name: spec.deps }, storage: { name: spec.storage }, spa: { name: spec.spa } } }
  const calls = [], faults = new Map(), responses = new Map()
  function run(label, cmd, args, io = {}) {
    calls.push({ label, cmd, args })
    if (faults.has(label)) { const left = faults.get(label); if (left > 0) { faults.set(label, left - 1); throw Error('Simulated failure: ' + label) } }
    if (responses.has(label)) return responses.get(label)()
    if (io.outputFile) fs.writeFileSync(io.outputFile, 'mock backup ' + label)
    if (label === 'panel-remote') return 'https://github.com/Guilherme100A/ai-manager.git'
    if (label === 'panel-head') return revision
    if (label === 'crm-head') return receipt.crm_head
    if (label === 'source-paths') return 'tracked.ts\0'
    if (label === 'base-config') return JSON.stringify(before)
    if (label === 'candidate-config') return JSON.stringify(after)
    if (label === 'verify-env-crm-web') return JSON.stringify(['PATH=/usr/sbin:/usr/bin'])
    if (label.startsWith('env-') || label.startsWith('verify-env-')) return JSON.stringify(Object.entries(env).map(([k, v]) => k + '=' + v))
    if (label === 'storage-mount' || label === 'worker-storage-mount') return JSON.stringify([{ Destination: '/data/storage', Type: 'volume', Name: 'preserved_storage' }])
    if (label.startsWith('verify-image-')) return JSON.stringify(image)
    if (label.startsWith('verify-mounts-')) return JSON.stringify(label.endsWith('crm-web') ? [{ Destination: '/usr/share/nginx/html', Type: 'volume', Name: spec.spa, RW: false }] : [{ Destination: '/crm/node_modules', Type: 'volume', Name: spec.deps, RW: false }, { Destination: '/data/storage', Type: 'volume', Name: spec.storage, RW: true }])
    if (label === 'principal-health' || label.startsWith('legacy-state-') || label.startsWith('verify-state-') || label.startsWith('recovery-state-')) return JSON.stringify({ Status: 'running', Health: { Status: 'healthy' } })
    if (label.startsWith('journal-')) return JSON.stringify(m.migrations.slice(0, Number(label.slice(8))).map(x => ({ hash: x.hash, created_at: x.when })))
    if (label === 'image-proof') return JSON.stringify({ Id: image, Architecture: 'amd64', Os: 'linux', Config: { Labels: { 'crm.source-tree': TREE } } })
    if (label === 'verify-business-area-schema') return JSON.stringify({ areas:true,resources:true,offer_column:true })
    if (label === 'verify-offer-schema') return JSON.stringify({ column: true, trigger: true, indexes: 2 })
    if (label === 'backup-legacy-source') fs.writeFileSync(args[1], 'mock private source backup')
    if (label === 'backup-storage') { const mount = args.find(x => x.endsWith(':/backup')); fs.writeFileSync(path.join(mount.slice(0, -8), 'storage.tgz'), 'mock storage') }
    if (label === 'copy-redis-backup') fs.writeFileSync(args.at(-1), 'mock redis snapshot')
    if (label === 'principal-id' || label.startsWith('id-') || label.startsWith('verify-id-') || label.startsWith('recovery-id-')) return 'id-' + label
    return ''
  }
  const options = { repo, state, artifact, receiptFile, manifestSha: hashFile(path.join(artifact, 'release.json')), lockHeld: true }
  return { root, repo, state, artifact, legacy, m, receipt, saveReceipt, options, calls, faults, responses, before, after, run, spec }
}

function installedFixture(t) {
  const f = fixture(t), company = '11111111-1111-4111-8111-111111111111'
  const old = { ...specFor({ release: 'd'.repeat(40), image_id: 'sha256:' + 'e'.repeat(64) }, f.spec.storage), source_tree: '24cec7d30f200818e64cd9693bfe8ff38ed1d0c3', company_id: company }
  const dir = path.join(f.state, 'releases', old.release)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(f.state, 'active.json'), JSON.stringify(old))
  fs.writeFileSync(path.join(dir, 'override.yml'), override(old))
  for (const model of [f.before, f.after]) for (const name of ['crm-api', 'crm-worker']) model.services[name].environment.SHARED_OFFERS_COMPANY_ID = company
  for (const name of ['crm-api', 'crm-worker']) f.responses.set('installed-image-' + name, () => JSON.stringify(old.image_id))
  return { ...f, company, old }
}
test('upgrading an activated historical release preserves company, storage and prior state backup', t => {
  const f = installedFixture(t)
  deploy(f.options, f.run)
  assert.deepEqual(read(path.join(f.state, 'active.json')), { ...f.spec, company_id: f.company })
  assert.deepEqual(read(path.join(f.state, 'releases', revision, 'backup', 'previous-active.json')), f.old)
  assert.equal(read(path.join(f.state, 'releases', revision, 'result.json')).gate_empty, false)
  assert.equal(read(path.join(f.state, 'releases', revision, 'result.json')).activation_preserved, true)
  assert.equal(f.calls.filter(c => c.label === 'journal-43').length, 2)
  assert.equal(f.calls.filter(c => c.label === 'journal-44').length, 1)
  assert.equal(fs.existsSync(path.join(f.state, 'maintenance.json')), false)
})
for (const mismatch of ['api-running', 'worker-config', 'candidate', 'persisted-tree', 'persisted-uuid', 'api-image', 'worker-image']) test('upgrade refuses activation/state drift before stopping CRM: ' + mismatch, t => {
  const f = installedFixture(t)
  if (mismatch === 'api-running') f.responses.set('env-crm-api', () => JSON.stringify(Object.entries(f.before.services['crm-api'].environment).map(([k,v]) => k + '=' + (k === 'SHARED_OFFERS_COMPANY_ID' ? '' : v))))
  if (mismatch === 'worker-config') f.before.services['crm-worker'] = { environment: { ...f.before.services['crm-worker'].environment, SHARED_OFFERS_COMPANY_ID: '' } }
  if (mismatch === 'candidate') f.after.services['crm-api'].environment.SHARED_OFFERS_COMPANY_ID = ''
  if (mismatch === 'persisted-tree') fs.writeFileSync(path.join(f.state, 'active.json'), JSON.stringify({ ...f.old, source_tree: 'f'.repeat(40) }))
  if (mismatch === 'persisted-uuid') fs.writeFileSync(path.join(f.state, 'active.json'), JSON.stringify({ ...f.old, company_id: 'invalid' }))
  if (mismatch === 'api-image') f.responses.set('installed-image-crm-api', () => JSON.stringify(image))
  if (mismatch === 'worker-image') f.responses.set('installed-image-crm-worker', () => JSON.stringify(image))
  assert.throws(() => deploy(f.options, f.run))
  assert.ok(!f.calls.some(c => c.label === 'stop-only-crm'))
})
test('activated upgrade accepts Nginx without a company gate and preserves API/worker activation', t => {
  const f = installedFixture(t)
  deploy(f.options, f.run)
  assert.equal(read(path.join(f.state, 'active.json')).company_id, f.company)
  assert.equal(read(path.join(f.state, 'releases', revision, 'result.json')).gate_empty, false)
  assert.equal(fs.existsSync(path.join(f.state, 'maintenance.json')), false)
})
for (const service of ['crm-api', 'crm-worker']) test('upgrade checks the preserved company in the actual new container after cutover: ' + service, t => {
  const f = installedFixture(t)
  f.responses.set('verify-env-' + service, () => JSON.stringify(['SHARED_OFFERS_COMPANY_ID=']))
  assert.throws(() => deploy(f.options, f.run), /Gate changed during cutover/)
  assert.equal(fs.existsSync(path.join(f.state, 'maintenance.json')), true)
})
test('successful deployment executes backups, CRM-only migration/cutover and persists next deploy', t => {
  const f = fixture(t); deploy(f.options, f.run)
  const labels = f.calls.map(c => c.label), index = x => labels.indexOf(x)
  assert.ok(index('principal-health') < index('stop-only-crm'))
  for (const name of ['backup-database', 'verify-database-backup', 'backup-legacy-source', 'backup-storage', 'backup-redis-snapshot', 'copy-redis-backup']) assert.ok(index(name) < index('migrate-only-crm'))
  assert.ok(index('migrate-only-crm') < index('journal-44') && index('journal-44') < index('cutover-crm-api'))
  assert.deepEqual(read(path.join(f.state, 'active.json')), f.spec)
  assert.equal(fs.existsSync(path.join(f.state, 'maintenance.json')), false)
  assert.ok(fs.readFileSync(path.join(f.root, 'deploy-ai-manager.sh'), 'utf8').includes('export CRM_RELEASE_STATE_DIR='))
  assert.equal(fs.readFileSync(path.join(f.state, 'deploy-vps.sh'), 'utf8'), '#!/bin/sh\n# mock persistent driver\n')
  const args = composeArgs(f.repo, f.state)
  assert.equal(args.at(-1), path.join(f.state, 'releases', revision, 'override.yml'))
  invoke(f.repo, f.state, ['run', '--rm', '--no-deps', 'crm-web-build'], f.run)
  assert.deepEqual(f.calls.at(-1).args.slice(-4), ['run', '--rm', '--no-deps', 'crm-web-build'])
  const migrate = f.calls.find(x => x.label === 'migrate-only-crm')
  assert.deepEqual(migrate.args.slice(-2), ['--set', 'crm'])
  assert.ok(!f.calls.some(x => ['restart', 'restore', 'down', 'FLUSHDB'].some(arg => x.args.includes(arg))))
  const result = read(path.join(f.state, 'releases', revision, 'result.json'))
  assert.equal(result.worker_health, 'running-only-not-proven-healthy')
})
const negatives = [
  ['no shared lock', f => { f.options.lockHeld = false }],
  ['wrong remote rhgab1', f => f.responses.set('panel-remote', () => 'https://github.com/rhgab1/ai-manager')],
  ['dirty panel', f => f.responses.set('panel-dirty', () => ' M source.ts')],
  ['panel head drift', f => f.responses.set('panel-head', () => 'd'.repeat(40))],
  ['legacy source drift', f => fs.appendFileSync(path.join(f.legacy, 'tracked.ts'), 'changed')],
  ['stale receipt', f => { f.receipt.observed_at = '2000-01-01T00:00:00Z'; f.saveReceipt() }],
  ['RPO unacknowledged', f => { f.receipt.ack_shared_database_rpo = false; f.saveReceipt() }],
  ['disk budget unavailable', f => { f.receipt.required_free_bytes = Number.MAX_SAFE_INTEGER; f.saveReceipt() }],
  ['artifact corruption', f => fs.appendFileSync(path.join(f.artifact, 'images.tar.gz'), 'tamper')],
  ['manifest corruption', f => fs.appendFileSync(path.join(f.artifact, 'release.json'), 'tamper')],
  ['RPC principal exited unhealthy', f => f.responses.set('principal-health', () => JSON.stringify({ Status: 'exited', ExitCode: 1, Health: { Status: 'unhealthy' } }))],
  ['RPC principal running unhealthy', f => f.responses.set('principal-health', () => JSON.stringify({ Status: 'running', Health: { Status: 'unhealthy' } }))],
  ['RPC principal missing', f => f.responses.set('principal-id', () => '')],
  ['old API unhealthy', f => f.responses.set('legacy-state-crm-api', () => JSON.stringify({ Status: 'running', Health: { Status: 'unhealthy' } }))],
  ['running company gate enabled', f => f.responses.set('env-crm-api', () => JSON.stringify(['SHARED_OFFERS_COMPANY_ID=unexpected']))],
  ['API secret missing', f => f.responses.set('env-crm-api', () => JSON.stringify(Object.entries(f.before.services['crm-api'].environment).filter(([k]) => k !== 'CREDENTIALS_KEY').map(([k, v]) => k + '=' + v)))],
  ['journal drift', f => f.responses.set('journal-39', () => '[]')],
  ['storage drift', f => { f.receipt.storage_volume = 'other_storage'; f.saveReceipt() }],
  ['worker uses different storage', f => f.responses.set('worker-storage-mount', () => '[]')],
  ['candidate gate enabled', f => { f.after.services['crm-api'].environment.SHARED_OFFERS_COMPANY_ID = 'unexpected' }],
  ['candidate secret changed', f => { f.after.services['crm-worker'].environment.CRM_SSO_SECRET = 'wrong' }],
  ['candidate source bind resurrected', f => f.after.services['crm-api'].volumes.push({ type: 'bind', target: '/crm' })],
  ['candidate old deps reused', f => { f.after.volumes.deps.name = 'legacy-deps' }],
  ['candidate storage replaced', f => { f.after.volumes.storage.name = 'new-storage' }],
  ['candidate future web-build compiles or installs', f => { f.after.services['crm-web-build'].command = ['pnpm', 'install'] }],
  ['candidate SPA old output', f => { f.after.volumes.spa.name = 'legacy-spa' }],
  ['wrong loaded image', f => f.responses.set('image-proof', () => JSON.stringify({ Id: 'sha256:' + 'f'.repeat(64) }))],
  ['preexisting deps volume', f => f.responses.set('volume-absent', () => 'previous-volume')],
]
for (const [name, change] of negatives) test(name + ' refuses before CRM stop/migration', t => {
  const f = fixture(t); change(f); assert.throws(() => deploy(f.options, f.run)); assert.ok(!f.calls.some(x => x.label === 'stop-only-crm' || x.label === 'migrate-only-crm'))
})
for (const label of ['stop-only-crm', 'backup-database', 'verify-database-backup', 'backup-legacy-source', 'backup-storage', 'backup-redis-snapshot', 'copy-redis-backup']) test(label + ' failure restores only old CRM before migration', t => {
  const f = fixture(t); f.faults.set(label, 1); assert.throws(() => deploy(f.options, f.run)); assert.ok(f.calls.some(x => x.label === 'restore-old-crm-before-migration')); assert.ok(!f.calls.some(x => x.label === 'migrate-only-crm')); assert.equal(fs.existsSync(path.join(f.state, 'active.json')), false)
})
for (const label of ['migrate-only-crm', 'journal-44', 'verify-offer-schema', 'verify-business-area-schema', 'cutover-crm-worker-web', 'verify-state-crm-worker', 'verify-spa-http', 'verify-mounts-crm-api', 'verify-image-crm-worker']) test(label + ' failure keeps maintenance, pauses CRM and never restores shared DB or old runtime', t => {
  const f = fixture(t); f.faults.set(label, 1); assert.throws(() => deploy(f.options, f.run)); assert.ok(fs.existsSync(path.join(f.state, 'maintenance.json'))); assert.ok(f.calls.some(x => x.label === 'pause-new-crm-in-maintenance')); assert.ok(!f.calls.some(x => x.label === 'restore-old-crm-before-migration')); assert.throws(() => invoke(f.repo, f.state, ['up', '-d', 'worker'], f.run), /maintenance/)
})
test('API health transient failure retries same immutable release', t => { const f = fixture(t); f.faults.set('cutover-crm-api', 1); deploy(f.options, f.run); assert.equal(f.calls.filter(x => x.label === 'cutover-crm-api').length, 2) })
test('partial stop changes worker state before failure; recovery verifies actual states', t => {
  const f = fixture(t), states = { 'crm-api': 'running', 'crm-worker': 'running' }; let attempted = false
  f.responses.set('stop-only-crm', () => { states['crm-worker'] = 'exited'; attempted = true; throw Error('Partial stop: worker stopped, API request failed') })
  f.responses.set('restore-old-crm-before-migration', () => { assert.equal(states['crm-worker'], 'exited'); states['crm-worker'] = 'running'; return '' })
  for (const name of Object.keys(states)) f.responses.set('recovery-state-' + name, () => JSON.stringify({ Status: states[name], Health: { Status: 'healthy' } }))
  assert.throws(() => deploy(f.options, f.run), /Partial stop/); assert.equal(attempted, true); assert.ok(Object.values(states).every(x => x === 'running')); assert.ok(f.calls.some(x => x.label === 'recovery-state-crm-worker')); assert.ok(!f.calls.some(x => x.label === 'migrate-only-crm')); assert.equal(fs.existsSync(path.join(f.state, 'maintenance.json')), false)
})
test('partial stop with unverified recovery records maintenance and blocks next deploy', t => {
  const f = fixture(t); let stoppedWorker = false
  f.responses.set('stop-only-crm', () => { stoppedWorker = true; throw Error('Partial stop') })
  f.responses.set('recovery-state-crm-worker', () => JSON.stringify({ Status: stoppedWorker ? 'exited' : 'running' }))
  assert.throws(() => deploy(f.options, f.run), /recovery unverified/); assert.equal(read(path.join(f.state, 'maintenance.json')).stage, 'legacy-recovery-unverified'); assert.throws(() => invoke(f.repo, f.state, ['build', 'dashboard'], f.run), /maintenance/)
})
test('artifact and backup hashing never reads whole binary files', t => {
  const f = fixture(t), originalRead = fs.readFileSync
  fs.readFileSync = function (file, ...args) { assert.ok(!/\.(?:gz|tgz|dump|rdb)$/.test(String(file)), 'Whole binary read forbidden'); return originalRead.call(this, file, ...args) }
  try { deploy(f.options, f.run) } finally { fs.readFileSync = originalRead }
})
test('malformed secret-bearing Compose output is not echoed in errors', t => {
  const f = fixture(t); f.responses.set('base-config', () => '{PRIVATE_SENTINEL_SECRET_INVALID_JSON'); assert.throws(() => deploy(f.options, f.run), e => !e.message.includes('PRIVATE_SENTINEL') && e.message.includes('Invalid JSON'))
})
test('empty backup fails before migration and restores old CRM', t => {
  const f = fixture(t); f.responses.set('backup-database', () => { fs.writeFileSync(path.join(f.state, 'releases', revision, 'backup/database.dump'), ''); return '' }); assert.throws(() => deploy(f.options, f.run), /Empty database backup/); assert.ok(f.calls.some(x => x.label === 'restore-old-crm-before-migration')); assert.ok(!f.calls.some(x => x.label === 'migrate-only-crm'))
})
for (const [label, value] of [['verify-env-crm-api', ['SHARED_OFFERS_COMPANY_ID=']], ['verify-mounts-crm-worker', []], ['verify-image-crm-api', 'sha256:' + 'e'.repeat(64)], ['verify-offer-schema', { column: false, trigger: true, indexes: 2 }]]) test(label + ' actual data mismatch retains maintenance', t => {
  const f = fixture(t); f.responses.set(label, () => JSON.stringify(value)); assert.throws(() => deploy(f.options, f.run)); assert.ok(fs.existsSync(path.join(f.state, 'maintenance.json'))); assert.ok(!f.calls.some(x => x.label === 'restore-old-crm-before-migration'))
})
test('API health permanent failure stops after three tries and retains maintenance', t => { const f = fixture(t); f.faults.set('cutover-crm-api', 3); assert.throws(() => deploy(f.options, f.run)); assert.equal(f.calls.filter(x => x.label === 'cutover-crm-api').length, 3); assert.ok(fs.existsSync(path.join(f.state, 'maintenance.json'))) })
test('principal goes down after backup: CRM migration never starts', t => { const f = fixture(t); let n = 0; f.responses.set('principal-health', () => JSON.stringify(++n === 1 ? { Status: 'running', Health: { Status: 'healthy' } } : { Status: 'exited' })); assert.throws(() => deploy(f.options, f.run)); assert.ok(!f.calls.some(x => x.label === 'migrate-only-crm')); assert.ok(f.calls.some(x => x.label === 'restore-old-crm-before-migration')) })
test('persistent override drift blocks subsequent panel or web build', t => { const f = fixture(t); deploy(f.options, f.run); fs.appendFileSync(path.join(f.state, 'releases', revision, 'override.yml'), 'tamper'); assert.throws(() => invoke(f.repo, f.state, ['build', 'dashboard'], f.run), /drift/) })
test('repeated same candidate never overwrites release, deps or backup', t => { const f = fixture(t); deploy(f.options, f.run); const data = fs.readFileSync(path.join(f.state, 'releases', revision, 'result.json')); assert.throws(() => deploy(f.options, f.run)); assert.deepEqual(fs.readFileSync(path.join(f.state, 'releases', revision, 'result.json')), data) })
test('Alpine/musl and full migration manifest are mandatory', t => { const f = fixture(t); for (const change of [m => { m.runtime = 'ubuntu' }, m => { m.source_tree = 'd'.repeat(40) }, m => { m.migrations.pop() }, m => { m.platform = 'linux/arm64' }]) { const m = structuredClone(f.m); change(m); assert.throws(() => validateManifest(m)) } })
test('generated override carries immutable source/deps/SPA and no UUID or credentials', t => { const f = fixture(t); const text = override(f.spec); assert.ok(text.includes('volumes: !override')); assert.ok(text.includes("SHARED_OFFERS_COMPANY_ID: ''")); assert.ok(!text.includes('pnpm install') && !text.includes('legacy') && !text.includes('fake-CREDENTIALS_KEY')) })
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const unix = p => process.platform === 'win32' ? p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()) : p
test('actual shell lock refusal prevents Node/deployment execution', t => {
  const f = fixture(t), bin = path.join(f.root, 'bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'flock'), '#!/bin/sh\nexit 73\n', { mode: 0o755 })
  const r = spawnSync(bash, ['-c', 'export PATH="$1:$PATH"; bash "$2" --apply', 'mock', unix(bin), unix(path.join(here, 'deploy.sh'))], { env: { ...process.env, AI_MANAGER_DEPLOY_LOCK: path.join(f.root, 'lock') }, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 3); assert.match(r.stderr, /lock busy/)
})
test('actual shell requires explicit apply; invalid forced SSH commands rejected', () => {
  const r = spawnSync(bash, [unix(path.join(here, 'deploy.sh'))], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 2)
  const s = spawnSync(bash, [unix(path.join(here, 'entrypoint.sh'))], { env: { ...process.env, SSH_ORIGINAL_COMMAND: 'echo unsafe' }, encoding: 'utf8', windowsHide: true }); assert.equal(s.status, 2)
})

function invokeInstalledBootstrap(f, useExternalDriver = false) {
  const env = { ...process.env, SSH_ORIGINAL_COMMAND: '~/deploy-ai-manager.sh ' + revision }
  const script = useExternalDriver ? path.join(f.state, 'deploy-vps.sh') : path.join(f.root, 'deploy-ai-manager.sh')
  if (useExternalDriver) { env.AI_MANAGER_DIR = f.options.repo; env.CRM_RELEASE_STATE_DIR = f.options.state }
  return spawnSync(bash, [unix(script)], { env, encoding: 'utf8', windowsHide: true, timeout: 3000 })
}
for (const fail of ['stop-only-crm', 'backup-database']) test('F-OP1 ' + fail + ' plus failed recovery blocks real forced-command bootstrap before Git/Docker', t => {
  const f = fixture(t)
  for (const k of ['repo', 'state', 'artifact', 'receiptFile']) f.options[k] = f.options[k].replaceAll('\\', '/')
  fs.copyFileSync(path.join(here, '../deploy-vps.sh'), path.join(f.repo, 'scripts/deploy-vps.sh'))
  f.faults.set(fail, 1); f.faults.set('restore-old-crm-before-migration', 1)
  assert.throws(() => deploy(f.options, f.run), /recovery unverified/)
  assert.equal(fs.readFileSync(path.join(f.state, 'releases', revision, 'backup/deploy-ai-manager.sh'), 'utf8'), 'previous bootstrap')
  assert.equal(read(path.join(f.state, 'releases', revision, 'backup/bootstrap-checksums.json'))['deploy-ai-manager.sh'], sha('previous bootstrap'))
  const actual = invokeInstalledBootstrap(f); assert.equal(actual.status, 4); assert.match(actual.stderr, /maintenance unresolved/)
  // Same guard also holds if the external driver is invoked directly after lock acquisition.
  const bin = path.join(f.root, 'mock-bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const direct = spawnSync(bash, ['-c', 'export PATH="$1:$PATH"; bash "$2"', 'mock', unix(bin), unix(path.join(f.state, 'deploy-vps.sh'))], { env: { ...process.env, AI_MANAGER_DIR: f.options.repo, CRM_RELEASE_STATE_DIR: f.options.state, AI_MANAGER_DEPLOY_LOCK: path.join(f.root, 'lock'), SSH_ORIGINAL_COMMAND: '~/deploy-ai-manager.sh ' + revision }, encoding: 'utf8', windowsHide: true, timeout: 3000 })
  assert.equal(direct.status, 4); assert.match(direct.stderr, /maintenance unresolved/)
})
test('F-OP1 failed bootstrap adoption does not stop CRM or replace previous bootstrap', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'deploy-ai-manager.sh.next'), 'untouched pending adoption')
  assert.throws(() => deploy(f.options, f.run), /EEXIST/)
  assert.equal(fs.readFileSync(path.join(f.root, 'deploy-ai-manager.sh'), 'utf8'), 'previous bootstrap')
  assert.ok(!f.calls.some(x => x.label === 'stop-only-crm'))
})
for (const reason of ['EEXIST', 'ENOSPC']) test('F-OP2 result ' + reason + ' preserves maintenance and real bootstrap block', t => {
  const f = fixture(t), originalWrite = fs.writeFileSync
  for (const k of ['repo', 'state', 'artifact', 'receiptFile']) f.options[k] = f.options[k].replaceAll('\\', '/')
  if (reason === 'EEXIST') f.responses.set('verify-spa-http', () => { fs.writeFileSync(path.join(f.state, 'releases', revision, 'result.json.next'), 'preserve prior pending data'); return '' })
  else fs.writeFileSync = function (file, ...args) { if (String(file).endsWith('result.json.next')) { const error = new Error('simulated ENOSPC'); error.code = 'ENOSPC'; throw error } return originalWrite.call(this, file, ...args) }
  try { assert.throws(() => deploy(f.options, f.run), new RegExp(reason)) } finally { fs.writeFileSync = originalWrite }
  assert.ok(f.calls.some(x => x.label === 'pause-new-crm-in-maintenance'))
  assert.ok(fs.existsSync(path.join(f.state, 'maintenance.json')))
  assert.equal(invokeInstalledBootstrap(f).status, 4)
})
test('F-OP2 catch reinstates externally missing maintenance before pausing CRM', t => {
  const f = fixture(t)
  f.responses.set('verify-spa-http', () => { fs.unlinkSync(path.join(f.state, 'maintenance.json')); fs.writeFileSync(path.join(f.state, 'releases', revision, 'result.json.next'), 'pending'); return '' })
  assert.throws(() => deploy(f.options, f.run), /EEXIST/)
  assert.equal(read(path.join(f.state, 'maintenance.json')).stage, 'post-migration-failed')
})
const pathCases = [
  ['state equals repo', f => { f.options.state = f.repo }],
  ['state inside repo', f => { f.options.state = path.join(f.repo, 'new-state') }],
  ['state inside legacy', f => { f.options.state = path.join(f.legacy, 'new-state') }],
  ['state inside artifact', f => { f.options.state = path.join(f.artifact, 'new-state') }],
  ['state ancestor of other directories', f => { f.options.state = f.root }],
  ['artifact inside repo', f => { const dir = path.join(f.repo, 'bundle'); fs.renameSync(f.artifact, dir); f.options.artifact = dir }],
  ['legacy inside state', f => { fs.mkdirSync(f.state); const dir = path.join(f.state, 'legacy'); fs.renameSync(f.legacy, dir); f.receipt.legacy_crm = dir; f.saveReceipt() }],
  ['receipt inside repo', f => { const file = path.join(f.repo, 'receipt.json'); fs.copyFileSync(f.options.receiptFile, file); f.options.receiptFile = file }],
  ['receipt inside state', f => { fs.mkdirSync(f.state); const file = path.join(f.state, 'receipt.json'); fs.copyFileSync(f.options.receiptFile, file); f.options.receiptFile = file }],
  ['receipt inside legacy', f => { const file = path.join(f.legacy, 'receipt.json'); fs.copyFileSync(f.options.receiptFile, file); f.options.receiptFile = file }],
  ['receipt inside artifact', f => { const file = path.join(f.artifact, 'receipt.json'); fs.copyFileSync(f.options.receiptFile, file); f.options.receiptFile = file }],
  ['state junction alias of repo', f => { const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.repo, alias, 'junction'); f.options.state = alias }],
  ['state under parent junction into legacy', f => { const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.legacy, alias, 'junction'); f.options.state = path.join(alias, 'nested') }],
  ['state releases junction redirects into repo', f => { fs.mkdirSync(f.state); fs.symlinkSync(f.repo, path.join(f.state, 'releases'), 'junction') }],
  ['receipt via artifact junction', f => { const file = path.join(f.artifact, 'receipt.json'); fs.copyFileSync(f.options.receiptFile, file); const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.artifact, alias, 'junction'); f.options.receiptFile = path.join(alias, 'receipt.json') }],
]
for (const [name, change] of pathCases) test('F-OP3 ' + name + ' rejected before any external step', t => {
  const f = fixture(t); change(f); assert.throws(() => deploy(f.options, f.run)); assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(f.repo, 'active.json')), false)
})
test('CI PostgreSQL utilities use same service16 container with streaming files, not runner PATH', t => {
  const f = fixture(t), container = 'd'.repeat(64), dump = path.join(f.root, 'fixture.dump'), uri = 'postgres://ci-only:ci-only@127.0.0.1/test'
  const a = pgClientPlan(container, 'pg_dump', ['-Fc', '--dbname', uri, '-f', dump])
  assert.deepEqual(a, { executable: 'docker', args: ['exec', container, 'pg_dump', '-Fc', '--dbname', uri], inputFile: undefined, outputFile: dump })
  const b = pgClientPlan(container, 'pg_restore', ['--list', dump]); assert.deepEqual(b.args, ['exec', '-i', container, 'pg_restore', '--list']); assert.equal(b.inputFile, dump)
  const c = pgClientPlan(container, 'pg_restore', ['--no-owner', '--exit-on-error', '--dbname', uri, dump]); assert.equal(c.inputFile, dump); assert.ok(c.args.includes('--exit-on-error')); assert.ok(!c.args.includes(dump))
  assert.equal(pg16Versions('pg_dump (PostgreSQL) 16.13', 'pg_restore (PostgreSQL) 16.13', '160013').client_location, 'same postgres16 CI service container')
  for (const versions of [['pg_dump (PostgreSQL) 17.1', 'pg_restore (PostgreSQL) 16.13', '160013'], ['pg_dump (PostgreSQL) 16.13', 'pg_restore (PostgreSQL) 15.1', '160013'], ['pg_dump (PostgreSQL) 16.13', 'pg_restore (PostgreSQL) 16.13', '170001']]) assert.throws(() => pg16Versions(...versions))
  assert.throws(() => pgClientPlan('', 'pg_dump', ['-f', dump])); assert.throws(() => pgClientPlan(container, 'other', []))
})

for (const sourceTree of ['6844b56c32af325ff203014afa0a2bcdc5ea9688', TREE]) test('area release accepts only the exact installed migration prefix: '+sourceTree, t => {
  const f=installedFixture(t); f.old.source_tree=sourceTree;
  fs.writeFileSync(path.join(f.state,'active.json'),JSON.stringify(f.old));
  fs.writeFileSync(path.join(f.state,'releases',f.old.release,'override.yml'),override(f.old));
  deploy(f.options,f.run);
  assert.ok(f.calls.some(c=>c.label==='journal-'+(sourceTree===TREE?44:43)));
  assert.equal(read(path.join(f.state,'active.json')).company_id,f.company);
});
test('missing business-area schema retains maintenance before any new API cutover', t => {
  const f=installedFixture(t); f.responses.set('verify-business-area-schema',()=>JSON.stringify({areas:true,resources:false,offer_column:true}));
  assert.throws(()=>deploy(f.options,f.run),/Business area schema/);
  assert.ok(fs.existsSync(path.join(f.state,'maintenance.json')));
  assert.ok(!f.calls.some(c=>c.label==='cutover-crm-api'));
  assert.ok(f.calls.some(c=>c.label==='pause-new-crm-in-maintenance'));
});
