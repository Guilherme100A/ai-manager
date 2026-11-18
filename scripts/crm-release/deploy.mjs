import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { TREE, sha, hashFile, read, parseJSON, requireThat, command, atomic, dedicatedPaths, validateManifest, specFor, override, composeArgs, validateConfig, sourceDigest, secrets, tsxCommand, availableMemoryBytes } from './lib.mjs'
const json = (run, label, cmd, args) => parseJSON(run(label, cmd, args), label)
export function deploy(options, run = command) {
  requireThat(options.lockHeld === true, 'Shared deployment lock required')
  const { repo, state, artifact, manifestSha, receiptFile } = options
  requireThat([repo, state, artifact, receiptFile].every(x => typeof x === 'string' && path.isAbsolute(x)), 'Absolute deployment paths required')
  requireThat(!fs.existsSync(path.join(state, 'maintenance.json')), 'Unresolved maintenance: reconcile before retry')
  const manifestFile = path.join(artifact, 'release.json')
  requireThat(/^[a-f0-9]{64}$/.test(manifestSha) && sha(fs.readFileSync(manifestFile)) === manifestSha, 'Manifest checksum mismatch')
  const m = validateManifest(read(manifestFile)), receipt = read(receiptFile)
  requireThat(typeof receipt.legacy_crm === 'string' && path.isAbsolute(receipt.legacy_crm), 'Absolute legacy CRM path required')
  dedicatedPaths({ repo, state, artifact, receiptFile, legacy: receipt.legacy_crm }, m.release)
  const age = Date.now() - Date.parse(receipt.observed_at)
  requireThat(Number.isFinite(age) && age >= 0 && age <= 900_000 && receipt.approved_panel_sha === m.release, 'Stale/unmatched preflight receipt')
  requireThat(receipt.ack_shared_database_rpo === true && /^[a-f0-9]{64}$/.test(receipt.source_sha256) && /^[a-f0-9]{40}$/.test(receipt.crm_head), 'Reviewed source/RPO receipt required')
  requireThat(path.isAbsolute(receipt.legacy_crm) && ![repo, state, artifact].includes(receipt.legacy_crm), 'Legacy CRM must remain separate')
  requireThat(Number.isSafeInteger(receipt.required_free_bytes) && receipt.required_free_bytes > 0, 'Explicit backup/disk budget required')
  for (const [file, hash] of [['images.tar.gz', m.images_sha256], ['spa.tar.gz', m.spa_sha256]]) requireThat(hashFile(path.join(artifact, file)) === hash, 'Artifact checksum mismatch')
  const remote = options.remote ?? 'origin'
  requireThat(/^[a-z][a-z0-9_-]*$/.test(remote), 'Invalid Git remote')
  const url = run('panel-remote', 'git', ['-C', repo, 'remote', 'get-url', remote])
  requireThat(['https://github.com/Guilherme100A/ai-manager.git', 'https://github.com/Guilherme100A/ai-manager', 'git@github.com:Guilherme100A/ai-manager.git'].includes(url), 'Wrong panel repository')
  requireThat(run('panel-head', 'git', ['-C', repo, 'rev-parse', 'HEAD']) === m.release, 'Panel revision drift')
  requireThat(run('panel-dirty', 'git', ['-C', repo, 'status', '--porcelain']) === '', 'Dirty panel source')
  requireThat(run('crm-head', 'git', ['-C', receipt.legacy_crm, 'rev-parse', 'HEAD']) === receipt.crm_head && sourceDigest(receipt.legacy_crm, run) === receipt.source_sha256, 'CRM source drift')
  const baseArgs = composeArgs(repo, state), dc = (label, args, io) => run(label, 'docker', [...baseArgs, ...args], io)
  const principal = () => {
    const id = dc('principal-id', ['ps', '-q', 'worker'])
    requireThat(id, 'Principal WhatsApp/RPC worker missing')
    const s = json(run, 'principal-health', 'docker', ['inspect', '--format', '{{json .State}}', id])
    requireThat(s.Status === 'running' && s.Health?.Status === 'healthy', 'Principal WhatsApp/RPC worker not healthy; never restarted by CRM deploy')
  }
  principal()
  const before = parseJSON(dc('base-config', ['config', '--format', 'json']), 'base-config')
  const activeFile = path.join(state, 'active.json')
  const installed = fs.existsSync(activeFile) ? read(activeFile) : null
  const company = installed?.company_id ?? ''
  // Validate the persisted UUID and compare it against both API/worker models and
  // containers. An upgrade can preserve activation, never introduce a new one.
  if (installed) override(installed)
  const ids = Object.fromEntries(['crm-api', 'crm-worker', 'postgres', 'redis'].map(name => [name, dc('id-' + name, ['ps', '-q', name])]))
  requireThat(Object.values(ids).every(Boolean), 'Required running services missing')
  for (const name of ['crm-api', 'crm-worker']) {
    const serviceState = json(run, 'legacy-state-' + name, 'docker', ['inspect', '--format', '{{json .State}}', ids[name]])
    requireThat(serviceState.Status === 'running' && (name !== 'crm-api' || serviceState.Health?.Status === 'healthy'), 'Legacy CRM not ready for controlled maintenance')
    const env = json(run, 'env-' + name, 'docker', ['inspect', '--format', '{{json .Config.Env}}', ids[name]])
    const actual = Object.fromEntries(env.map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)] }))
    requireThat((actual.SHARED_OFFERS_COMPANY_ID ?? '') === company && (before.services[name].environment.SHARED_OFFERS_COMPANY_ID ?? '') === company, 'Company gate drift in running or configured services')
    if (installed) requireThat(json(run, 'installed-image-' + name, 'docker', ['inspect', '--format', '{{json .Image}}', ids[name]]) === installed.image_id, 'Installed CRM image drift')
    for (const key of secrets) requireThat(actual[key] && actual[key] === before.services[name].environment[key], 'Running/configured credential drift')
  }
  const mounts = json(run, 'storage-mount', 'docker', ['inspect', '--format', '{{json .Mounts}}', ids['crm-api']])
  const storage = mounts.filter(x => x.Destination === '/data/storage' && x.Type === 'volume')
  requireThat(storage.length === 1 && storage[0].Name === receipt.storage_volume, 'Storage observation drift')
  const workerMounts = json(run, 'worker-storage-mount', 'docker', ['inspect', '--format', '{{json .Mounts}}', ids['crm-worker']])
  requireThat(workerMounts.filter(x => x.Destination === '/data/storage' && x.Type === 'volume' && x.Name === storage[0].Name).length === 1, 'API/worker storage mismatch')
  const spec = specFor(m, storage[0].Name)
  if (installed?.company_id !== undefined) spec.company_id = company
  const pg = before.services.postgres.environment
  requireThat(/^[a-zA-Z0-9_]+$/.test(pg.POSTGRES_USER) && /^[a-zA-Z0-9_]+$/.test(pg.POSTGRES_DB), 'Invalid database identity')
  const psql = sql => ['exec', '-T', 'postgres', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', pg.POSTGRES_USER, '-d', pg.POSTGRES_DB, '-c', sql]
  const checkJournal = count => {
    const applied = parseJSON(dc('journal-' + count, psql('BEGIN READ ONLY; SELECT coalesce(json_agg(t),\'[]\') FROM (SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at) t; COMMIT;')), 'CRM journal')
    requireThat(Array.isArray(applied) && applied.length === count && applied.every((x, i) => x.hash === m.migrations[i].hash && Number(x.created_at) === m.migrations[i].when), 'CRM migration history drift')
  }
  const beforeCount = installed ? ((installed.source_tree === TREE || installed.source_tree === 'f222d1b555a0e4e92ca8f86503f35fadb3099c0e') ? 46 : installed.source_tree === '91134a774990fb63abf05764e508f315f1944664' ? 45 : ['7158e6027f11a6a4e77910d5a9c536109848a6c9', 'e39405197247f463dec69388a29d43c187a22332'].includes(installed.source_tree) ? 44 : 43) : 39
  checkJournal(beforeCount)
  fs.mkdirSync(state, { recursive: true, mode: 0o700 })
  const space = fs.statfsSync(state)
  let meminfo
  if (process.platform === 'linux') { try { meminfo = fs.readFileSync('/proc/meminfo', 'utf8') } catch { /* Conservative fallback to actual free memory. */ } }
  requireThat(space.bavail * space.bsize >= receipt.required_free_bytes && availableMemoryBytes(meminfo, os.freemem()) >= 256 * 1024 * 1024, 'Insufficient resources for reviewed backup budget')
  const dir = path.join(state, 'releases', m.release)
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })
  fs.mkdirSync(dir, { mode: 0o700 }) // Existing candidate is never overwritten; reconciliation is explicit.
  const candidate = path.join(dir, 'override.yml')
  fs.writeFileSync(candidate, override(spec), { flag: 'wx', mode: 0o600 })
  const nextArgs = composeArgs(repo, state, candidate), next = (label, args, io) => run(label, 'docker', [...nextArgs, ...args], io)
  validateConfig(before, parseJSON(next('candidate-config', ['config', '--format', 'json']), 'candidate-config'), spec)
  run('load-audited-image', 'docker', ['load', '--input', path.join(artifact, 'images.tar.gz')])
  const image = json(run, 'image-proof', 'docker', ['image', 'inspect', m.image, '--format', '{{json .}}'])
  requireThat(image.Id === m.image_id && image.Config?.Labels?.['crm.source-tree'] === TREE && image.Architecture === 'amd64' && image.Os === 'linux', 'Loaded image identity/platform/tree drift')
  for (const volume of [spec.deps, spec.spa]) {
    requireThat(run('volume-absent', 'docker', ['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}']) === '', 'Release volume already exists')
    run('create-release-volume', 'docker', ['volume', 'create', '--label', `crm.release=${m.release}`, volume])
  }
  run('seed-and-check-deps', 'docker', ['run', '--rm', '--network', 'none', '-v', `${spec.deps}:/crm/node_modules:ro`, m.image_id, 'node', '-e', "require('fs').accessSync('/crm/node_modules/tsx/dist/cli.mjs')"])
  next('prepare-ci-spa', ['run', '--rm', '--no-deps', 'crm-web-build'])
  const backup = path.join(dir, 'backup')
  fs.mkdirSync(backup, { mode: 0o700 })
  const bootstrap = path.resolve(repo, '../deploy-ai-manager.sh'), maintenance = path.join(state, 'maintenance.json')
  // Preserve the prior entrypoint/driver BEFORE replacing them or stopping CRM.
  if (fs.existsSync(bootstrap)) fs.copyFileSync(bootstrap, path.join(backup, 'deploy-ai-manager.sh'), fs.constants.COPYFILE_EXCL)
  if (fs.existsSync(path.join(state, 'deploy-vps.sh'))) fs.copyFileSync(path.join(state, 'deploy-vps.sh'), path.join(backup, 'previous-deploy-driver.sh'), fs.constants.COPYFILE_EXCL)
  if (fs.existsSync(path.join(state, 'active.json'))) fs.copyFileSync(path.join(state, 'active.json'), path.join(backup, 'previous-active.json'), fs.constants.COPYFILE_EXCL)
  atomic(path.join(backup, 'bootstrap-checksums.json'), Object.fromEntries(fs.readdirSync(backup).map(file => [file, hashFile(path.join(backup, file))])))
  let stopped = false, migrationAttempted = false
  try {
    // A stop can fail after changing one service. Its recovery may also fail:
    // the real forced-command entrypoint must enforce maintenance already then.
    fs.copyFileSync(path.join(repo, 'scripts/deploy-vps.sh'), path.join(state, 'deploy-vps.sh.next'), fs.constants.COPYFILE_EXCL)
    fs.chmodSync(path.join(state, 'deploy-vps.sh.next'), 0o700); fs.renameSync(path.join(state, 'deploy-vps.sh.next'), path.join(state, 'deploy-vps.sh'))
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    const entrypoint = fs.readFileSync(path.join(repo, 'scripts/crm-release/entrypoint.sh'), 'utf8').replace('#!/usr/bin/env bash\n', `#!/usr/bin/env bash\nexport AI_MANAGER_DIR=${quote(repo)}\nexport CRM_RELEASE_STATE_DIR=${quote(state)}\nexport AI_MANAGER_REMOTE=${quote(remote)}\n`)
    fs.writeFileSync(bootstrap + '.next', entrypoint, { flag: 'wx', mode: 0o700 })
    fs.chmodSync(bootstrap + '.next', 0o700); fs.renameSync(bootstrap + '.next', bootstrap)
    atomic(maintenance, { release: m.release, stage: 'before-crm-stop', automatic_database_restore: false })
    stopped = true; dc('stop-only-crm', ['stop', '-t', '90', 'crm-worker', 'crm-api'])
    dc('backup-database', ['exec', '-T', 'postgres', 'pg_dump', '-U', pg.POSTGRES_USER, '-d', pg.POSTGRES_DB, '-Fc'], { outputFile: path.join(backup, 'database.dump') })
    requireThat(fs.statSync(path.join(backup, 'database.dump')).size > 0, 'Empty database backup')
    dc('verify-database-backup', ['exec', '-T', 'postgres', 'pg_restore', '--list'], { inputFile: path.join(backup, 'database.dump'), outputFile: path.join(backup, 'database.list') })
    requireThat(fs.statSync(path.join(backup, 'database.list')).size > 0, 'Backup TOC verification empty')
    run('backup-legacy-source', 'tar', ['-czf', path.join(backup, 'legacy-crm.tgz'), '-C', receipt.legacy_crm, '.'])
    run('backup-storage', 'docker', ['run', '--rm', '--network', 'none', '-v', `${spec.storage}:/from:ro`, '-v', `${backup}:/backup`, m.image_id, 'tar', '-czf', '/backup/storage.tgz', '-C', '/from', '.'])
    // Redis full-sync snapshot; preserves stream/group data without consuming or trimming it.
    const redisFile = `/data/crm-backup-${m.release}.rdb`
    dc('backup-redis-snapshot', ['exec', '-T', 'redis', 'redis-cli', '--rdb', redisFile])
    run('copy-redis-backup', 'docker', ['cp', `${ids.redis}:${redisFile}`, path.join(backup, 'redis.rdb')])
    for (const file of ['.env', 'docker-compose.yml', 'docker-compose.crm.yml']) fs.copyFileSync(path.join(repo, file), path.join(backup, path.basename(file)))
    for (const file of ['legacy-crm.tgz', 'storage.tgz', 'redis.rdb']) requireThat(fs.statSync(path.join(backup, file)).size > 0, 'Incomplete backup')
    atomic(path.join(backup, 'checksums.json'), Object.fromEntries(fs.readdirSync(backup).map(f => [f, hashFile(path.join(backup, f))])))
    principal(); checkJournal(beforeCount)
    atomic(maintenance, { release: m.release, stage: 'migration-attempted', automatic_database_restore: false })
    migrationAttempted = true // Unknown commit state on any migration failure: never restart old binaries.
    next('migrate-only-crm', ['run', '--rm', '--no-deps', 'crm-api', ...tsxCommand('/crm/packages/db/src/migrate.ts'), '--set', 'crm'])
    checkJournal(46)
    const schema = parseJSON(dc('verify-offer-schema', psql("BEGIN READ ONLY; SELECT json_build_object('column',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='crm' AND table_name='flow_runs' AND column_name='offer_scoped'),'trigger',EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='validate_offer_run_scope'),'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='crm' AND indexname IN ('flow_runs_active_contact_uq','flow_runs_active_chat_uq'))); COMMIT;")), 'schema')
    requireThat(schema.column === true && schema.trigger === true && schema.indexes === 2, 'CRM schema verification failed')
    const areas = parseJSON(dc('verify-business-area-schema', psql("BEGIN READ ONLY; SELECT json_build_object('areas',to_regclass('crm.business_areas') IS NOT NULL,'resources',to_regclass('crm.business_area_resources') IS NOT NULL,'offer_column',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='crm' AND table_name='offers' AND column_name='business_area_id')); COMMIT;")), 'business area schema')
    requireThat(areas.areas === true && areas.resources === true && areas.offer_column === true, 'Business area schema verification failed')
    const identity = parseJSON(dc('verify-message-identity-schema', psql("BEGIN READ ONLY; SELECT json_build_object('scoped',to_regclass('crm.messages_company_connection_wa_id_uq') IS NOT NULL,'old_global',to_regclass('crm.messages_company_wa_id_uq') IS NOT NULL,'column',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='crm' AND table_name='messages' AND column_name='connection_id' AND is_nullable='NO'),'trigger',EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='bind_message_connection' AND tgrelid='crm.messages'::regclass AND tgenabled='O'),'fk',(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='messages_chat_connection_fk' AND conrelid='crm.messages'::regclass AND convalidated)); COMMIT;")), 'message identity schema')
    requireThat(identity.scoped === true && identity.old_global === false && identity.column === true && identity.trigger === true && typeof identity.fk === 'string' && identity.fk.includes('FOREIGN KEY (company_id, chat_id, connection_id)') && identity.fk.includes('REFERENCES crm.chats(company_id, id, connection_id)'), 'Message identity schema verification failed')
    const pendingStatus = parseJSON(dc('verify-pending-message-status-schema', psql("BEGIN READ ONLY; SELECT json_build_object('table',to_regclass('crm.pending_message_status') IS NOT NULL,'connection_index',to_regclass('crm.connections_company_id_uq') IS NOT NULL,'fk',(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='pending_message_status_connection_fk' AND conrelid='crm.pending_message_status'::regclass AND convalidated),'expiry',EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='crm' AND table_name='pending_message_status' AND column_name='expires_at' AND is_nullable='NO')); COMMIT;")), 'pending message status schema')
    requireThat(pendingStatus.table === true && pendingStatus.connection_index === true && pendingStatus.expiry === true && typeof pendingStatus.fk === 'string' && pendingStatus.fk.includes('FOREIGN KEY (company_id, connection_id)') && pendingStatus.fk.includes('REFERENCES crm.connections(company_id, id)'), 'Pending message status schema verification failed')
    principal()
    atomic(path.join(state, 'active.json'), spec)
    let ready = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try { next('cutover-crm-api', ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'crm-api']); ready = true; break } catch { if (attempt === 2) throw Error('CRM API health failed; new schema/image kept in maintenance') }
    }
    requireThat(ready, 'CRM API unavailable')
    next('cutover-crm-worker-web', ['up', '-d', '--no-deps', 'crm-worker', 'crm-web'])
    for (const name of ['crm-api', 'crm-worker', 'crm-web']) {
      const id = next('verify-id-' + name, ['ps', '-q', name])
      const s = json(run, 'verify-state-' + name, 'docker', ['inspect', '--format', '{{json .State}}', id])
      requireThat(s.Status === 'running' && (name !== 'crm-api' || s.Health?.Status === 'healthy'), 'CRM service not ready')
      const e = json(run, 'verify-env-' + name, 'docker', ['inspect', '--format', '{{json .Config.Env}}', id])
      const actualMounts = json(run, 'verify-mounts-' + name, 'docker', ['inspect', '--format', '{{json .Mounts}}', id])
      if (name !== 'crm-web') {
        requireThat(e.includes('SHARED_OFFERS_COMPANY_ID=' + company), 'Gate changed during cutover')
        for (const key of secrets) requireThat(e.includes(key + '=' + before.services[name].environment[key]), 'Credential changed during cutover')
        requireThat(json(run, 'verify-image-' + name, 'docker', ['inspect', '--format', '{{json .Image}}', id]) === m.image_id, 'Running image drift')
        requireThat(!actualMounts.some(x => x.Type === 'bind' || x.Destination === '/crm') && actualMounts.some(x => x.Destination === '/crm/node_modules' && x.Name === spec.deps && x.RW === false) && actualMounts.some(x => x.Destination === '/data/storage' && x.Name === spec.storage), 'Running dependency/storage mount drift')
      } else requireThat(actualMounts.some(x => x.Destination === '/usr/share/nginx/html' && x.Name === spec.spa && x.RW === false), 'Running SPA mount drift')
    }
    next('verify-spa-http', ['exec', '-T', 'crm-web', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/index.html'])
    principal()
    atomic(path.join(dir, 'result.json'), { installed: true, release: m.release, gate_empty: company === '', activation_preserved: Boolean(installed), worker_health: 'running-only-not-proven-healthy', browser_and_mcp_verification_required: true })
    // No critical file writes after releasing the persistent maintenance gate.
    fs.unlinkSync(maintenance)
    return spec
  } catch (error) {
    if (!migrationAttempted && stopped) {
      try {
        dc('restore-old-crm-before-migration', ['up', '-d', '--no-deps', '--wait', 'crm-api', 'crm-worker'])
        for (const name of ['crm-api', 'crm-worker']) {
          const id = dc('recovery-id-' + name, ['ps', '-q', name])
          requireThat(id, 'Recovery service missing')
          const recovered = json(run, 'recovery-state-' + name, 'docker', ['inspect', '--format', '{{json .State}}', id])
          requireThat(recovered.Status === 'running' && (name !== 'crm-api' || recovered.Health?.Status === 'healthy'), 'Recovery service not ready')
        }
        fs.unlinkSync(maintenance) // All legacy states verified before clearing protection.
      } catch {
        atomic(path.join(state, 'maintenance.json'), { release: m.release, stage: 'legacy-recovery-unverified', migration_attempted: false, automatic_database_restore: false })
        throw Error('Pre-migration failure; legacy recovery unverified, maintenance retained')
      }
    }
    if (migrationAttempted) {
      if (!fs.existsSync(maintenance)) atomic(maintenance, { release: m.release, stage: 'post-migration-failed', automatic_database_restore: false })
      try { next('pause-new-crm-in-maintenance', ['stop', '-t', '90', 'crm-worker', 'crm-api']) } catch { /* Preserve original failure and explicit maintenance marker. */ }
    }
    // No DROP/restore/down -v/FLUSHDB. After possible schema change, old runtime remains stopped.
    throw error
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [repo, state, artifact, manifestSha, receiptFile, remote] = process.argv.slice(2)
    process.umask(0o077)
    deploy({ repo, state, artifact, manifestSha, receiptFile, remote, lockHeld: process.env.CRM_RELEASE_LOCK_HELD === '1' })
    console.log('CRM installed; existing activation preserved. Separate browser/MCP verification required.')
  } catch (e) { console.error(e.message); process.exitCode = 1 }
}
