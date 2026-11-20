import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
export const TREE = 'da9a28906e0766b05440a0e68c7fe1822e2e07aa'
// Historical immutable release accepted only as the currently installed source.
// New artifacts must match TREE exactly; never accept arbitrary historical trees.
export const INSTALLED_CRM_JOURNALS = new Map([
  [TREE, 49],
  ['5d4d9a5897bf1ae6a4014a6ab892ff35709bf7b9', 49],
  ['6e93ea0546991123f8436bc75c68027ba30d63eb', 49],
  ['b0768b479dcddf637bfc5832753be02b972cfc4b', 48],
  ['d2ebd86493f4a1a5ad79298c91b75247a766c695', 48],
  ['acc2a3c3e355958be0fb5feed6214cd94c2088f6', 47],
  ['af9c8482823fb72833a14041af6183027e21a6f2', 47],
  ['62ef8c2a0223928bc41e62046de59dea708197f7', 47],
  ['d0489b7ae0b69fcd0adcb1d8db36ddcf5028bff4', 47],
  ['fe9dbf880d74e6dc4550735b24527756cbd9afc4', 46],
  ['f222d1b555a0e4e92ca8f86503f35fadb3099c0e', 46],
  ['91134a774990fb63abf05764e508f315f1944664', 45],
  ['7158e6027f11a6a4e77910d5a9c536109848a6c9', 44],
  ['e39405197247f463dec69388a29d43c187a22332', 44],
  ['6844b56c32af325ff203014afa0a2bcdc5ea9688', 43],
  ['24cec7d30f200818e64cd9693bfe8ff38ed1d0c3', 43],
])
export const sha = b => createHash('sha256').update(b).digest('hex')
export function hashFile(file) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, 'r')
  try { let n; while ((n = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, n)); return hash.digest('hex') } finally { fs.closeSync(fd) }
}
export const parseJSON = (text, label) => { try { return JSON.parse(text) } catch { throw new Error(`Invalid JSON: ${label}`) } }
export const read = file => parseJSON(fs.readFileSync(file, 'utf8'), 'input file')
export const requireThat = (ok, message) => { if (!ok) throw new Error(message) }
export function availableMemoryBytes(meminfo, freeBytes) {
  // Linux MemAvailable accounts for reclaimable cache. MemFree alone can be
  // small even while the host has ample memory for the reviewed operation.
  const rows = typeof meminfo === 'string' ? [...meminfo.matchAll(/^MemAvailable:\s+(\d+) kB\s*$/gm)] : []
  const bytes = rows.length === 1 ? Number(rows[0][1]) * 1024 : NaN
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : freeBytes
}
export const secrets = ['DATABASE_URL', 'REDIS_URL', 'CREDENTIALS_KEY', 'CRM_SSO_SECRET', 'INTERNAL_TOKEN']
export const metaEnvironment = ['META_APP_ID', 'META_APP_SECRET', 'META_OAUTH_REDIRECT_URI']
export function command(label, executable, args, io = {}) {
  const descriptors = []
  try {
    const stdin = io.inputFile ? fs.openSync(io.inputFile, 'r') : 'ignore'
    const stdout = io.outputFile ? fs.openSync(io.outputFile, 'wx', 0o600) : 'pipe'
    if (typeof stdin === 'number') descriptors.push(stdin)
    if (typeof stdout === 'number') descriptors.push(stdout)
    const r = spawnSync(executable, args, { cwd: io.cwd, encoding: 'utf8', stdio: [stdin, stdout, 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: io.timeout ?? 300_000, windowsHide: true })
    // Do not echo config, credentials, stderr, or command arguments into deploy logs.
    requireThat(!r.error && r.status === 0, `Step failed: ${label}`)
    return r.stdout?.trim() ?? ''
  } finally { for (const fd of descriptors) fs.closeSync(fd) }
}
export function atomic(file, value) {
  const tmp = file + '.next'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
}
// Resolve existing parents without creating anything; nonexistent state children
// are appended only after resolving the nearest real filesystem ancestor.
export function canonicalPath(input) {
  let cursor = path.resolve(input)
  const tail = []
  for (;;) {
    let stat
    try { stat = fs.lstatSync(cursor) } catch (e) { requireThat(e.code === 'ENOENT', 'Unresolvable deployment path') }
    if (stat) {
      try { return path.join(fs.realpathSync.native(cursor), ...tail.reverse()) } catch { throw Error('Dangling or inaccessible deployment path') }
    }
    const parent = path.dirname(cursor)
    requireThat(parent !== cursor, 'Deployment path has no real ancestor')
    tail.push(path.basename(cursor)); cursor = parent
  }
}
const contains = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
export function dedicatedPaths({ repo, state, artifact, receiptFile, legacy }, release) {
  const directories = [repo, state, artifact, legacy].map(canonicalPath)
  for (let i = 0; i < directories.length; i++) for (let j = i + 1; j < directories.length; j++) requireThat(!contains(directories[i], directories[j]) && !contains(directories[j], directories[i]), 'Deployment directories must be dedicated and disjoint')
  for (const dir of [repo, artifact, legacy]) requireThat(fs.statSync(dir).isDirectory(), 'Source/artifact directory missing')
  if (fs.existsSync(state)) requireThat(fs.statSync(state).isDirectory(), 'State must be a directory')
  const receipt = canonicalPath(receiptFile), bootstrap = path.resolve(repo, '../deploy-ai-manager.sh')
  requireThat(fs.statSync(receiptFile).isFile() && !directories.some(dir => contains(dir, receipt)), 'Receipt must be a separate file outside deployment directories')
  requireThat(!directories.some(dir => contains(dir, canonicalPath(bootstrap))) && receipt !== canonicalPath(bootstrap), 'Unsafe bootstrap/receipt placement')
  // These fixed mutable endpoints must not redirect writes through a junction or
  // symlink, even when the state root itself appears to be outside the checkout.
  for (const file of [state, path.join(state, 'releases'), path.join(state, 'releases', release), path.join(state, 'maintenance.json'), path.join(state, 'active.json'), path.join(state, 'deploy-vps.sh'), bootstrap]) {
    let stat
    try { stat = fs.lstatSync(file) } catch (e) { requireThat(e.code === 'ENOENT', 'Inaccessible mutable deployment endpoint') }
    requireThat(!stat?.isSymbolicLink(), 'Symlink/junction mutable deployment endpoint forbidden')
  }
}
export function validateManifest(m) {
  requireThat(m?.format === 1 && /^[a-f0-9]{40}$/.test(m.release) && m.source_tree === TREE, 'Invalid release identity/tree')
  requireThat(m.image === `crm-shared-offers:${m.release}` && /^sha256:[a-f0-9]{64}$/.test(m.image_id), 'Invalid image identity')
  requireThat(m.platform === 'linux/amd64' && m.runtime === 'node:22-alpine', 'Release must use Alpine/musl dependencies')
  for (const k of ['images_sha256', 'spa_sha256']) requireThat(/^[a-f0-9]{64}$/.test(m[k]), 'Missing artifact checksum')
  requireThat(Array.isArray(m.migrations) && m.migrations.length === 49, 'Full CRM migration contract required')
  m.migrations.forEach((x, i) => requireThat(x.idx === i && /^[a-f0-9]{64}$/.test(x.hash) && Number.isSafeInteger(x.when) && typeof x.tag === 'string', 'Invalid migration contract'))
  requireThat(new Set(m.migrations.map(x => x.when)).size === 49 && new Set(m.migrations.map(x => x.tag)).size === 49, 'Duplicate migrations')
  requireThat(m.migrations.slice(39).map(x => x.tag).join(',') === '0039_shared_offers,0040_offer_delivery_recovery,0041_offer_block_push,0042_offer_tenant_scope,0043_business_areas,0044_chat_wa_identity,0045_pending_message_status,0046_workspace_flow_sharing,0047_workspace_meta,0048_pixel_allowed_events', 'Unexpected migrations')
  return m
}
export function specFor(m, storage) {
  requireThat(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(storage), 'Invalid preserved storage volume')
  return { format: 1, release: m.release, source_tree: TREE, image_id: m.image_id, deps: `crm_so_${m.release}_deps`, spa: `crm_so_${m.release}_spa`, storage }
}
// tsx launches another Node process: conditions must be CLI arguments to tsx,
// not arguments to its parent Node process (whose execArgv is not inherited).
export const tsxCommand = entry => ['node', '/crm/node_modules/tsx/dist/cli.mjs', '--conditions=development', entry]
export function override(spec) {
  const q = JSON.stringify
  const company = spec.company_id === undefined ? '' : spec.company_id
  requireThat(typeof company === 'string' && (company === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(company)), 'Invalid activation company UUID')
  const commandLine = app => q(tsxCommand(`/crm/apps/${app}/src/${app === 'api' ? 'server' : 'main'}.ts`))
  const runtime = app => `    image: ${q(spec.image_id)}\n    pull_policy: never\n    read_only: true\n    tmpfs: [/tmp]\n    environment:\n      SHARED_OFFERS_COMPANY_ID: ${company ? q(company) : "''"}\n    volumes: !override\n      - crm-release-deps:/crm/node_modules:ro\n      - crm-storage:/data/storage\n    command: ${commandLine(app)}\n`
  return `# Generated from an audited CI artifact; no credentials or company UUID. Compose >=2.24.4.\nservices:\n  crm-api:\n${runtime('api')}    healthcheck:\n      test: ${q(['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"])}\n  crm-worker:\n${runtime('worker')}  crm-web:\n    volumes: !override\n      - crm-release-spa:/usr/share/nginx/html:ro\n  crm-web-build:\n    image: ${q(spec.image_id)}\n    pull_policy: never\n    working_dir: /crm\n    read_only: true\n    volumes: !override\n      - crm-release-spa:/out\n    command: ['cp', '-a', '/crm/apps/web/dist/.', '/out/']\nvolumes:\n  crm-release-deps:\n    external: true\n    name: ${q(spec.deps)}\n  crm-release-spa:\n    external: true\n    name: ${q(spec.spa)}\n  crm-storage:\n    external: true\n    name: ${q(spec.storage)}\n`
}
export function composeArgs(repo, stateDir, explicitOverride) {
  const args = ['compose', '--project-directory', repo, '-f', path.join(repo, 'docker-compose.yml'), '-f', path.join(repo, 'docker-compose.crm.yml')]
  let file = explicitOverride
  const active = path.join(stateDir, 'active.json')
  if (!file && fs.existsSync(active)) {
    const spec = read(active)
    requireThat(INSTALLED_CRM_JOURNALS.has(spec.source_tree) && /^[a-f0-9]{40}$/.test(spec.release), 'Invalid persisted release')
    requireThat(specFor({ release: spec.release, image_id: spec.image_id }, spec.storage).deps === spec.deps, 'Invalid deps state')
    requireThat(spec.spa === `crm_so_${spec.release}_spa` && /^sha256:[a-f0-9]{64}$/.test(spec.image_id), 'Invalid SPA/image state')
    file = path.join(stateDir, 'releases', spec.release, 'override.yml')
    requireThat(fs.readFileSync(file, 'utf8') === override(spec), 'Persistent override drift')
  }
  if (file) args.push('-f', file)
  return args
}
export function validateConfig(before, after, spec) {
  const services = after?.services
  requireThat(services && before?.services, 'Missing resolved Compose model')
  for (const name of ['crm-api', 'crm-worker']) {
    const b = before.services[name], a = services[name]
    const company = spec.company_id ?? ''
    requireThat(a && b && a.image === spec.image_id && a.environment?.SHARED_OFFERS_COMPANY_ID === company, 'Image/gate mismatch')
    for (const key of [...secrets, 'WA_GATEWAY', 'WA_RPC_PROFILE', 'WA_RPC_URL', 'WA_EVENTS_STREAM', 'CRM_QUEUE_PREFIX']) requireThat(typeof a.environment[key] === 'string' && a.environment[key].length > 0 && a.environment[key] === b.environment[key], 'Runtime secret/RPC drift')
    for (const key of metaEnvironment) requireThat((a.environment[key] ?? '') === (b.environment[key] ?? ''), 'Meta configuration drift')
    requireThat((b.environment.SHARED_OFFERS_COMPANY_ID ?? '') === company && a.environment.WA_GATEWAY === 'rpc' && a.environment.WA_RPC_PROFILE === 'ai-manager', 'Company gate/RPC must remain unchanged')
    requireThat(a.volumes?.length === 2 && !a.volumes.some(v => v.type === 'bind' || v.target === '/crm'), 'Mutable source mount forbidden')
    const deps = a.volumes.find(v => v.target === '/crm/node_modules'), storage = a.volumes.find(v => v.target === '/data/storage')
    requireThat(deps?.read_only === true && after.volumes[deps.source]?.name === spec.deps && after.volumes[storage?.source]?.name === spec.storage, 'Dependency/storage mismatch')
    requireThat(a.command?.join(' ') === tsxCommand(`/crm/apps/${name === 'crm-api' ? 'api/src/server' : 'worker/src/main'}.ts`).join(' '), 'Unexpected startup/install command')
  }
  for (const name of ['crm-web', 'crm-web-build']) {
    const s = services[name], target = name === 'crm-web' ? '/usr/share/nginx/html' : '/out'
    requireThat(s?.volumes?.length === 1 && s.volumes[0].target === target && after.volumes[s.volumes[0].source]?.name === spec.spa, 'SPA mount drift')
  }
  requireThat(services['crm-web-build'].command?.join(' ') === 'cp -a /crm/apps/web/dist/. /out/' && services['crm-web-build'].image === spec.image_id, 'Future web-build must only copy the same CI SPA')
}
export function sourceDigest(dir, run = command) {
  const tracked = run('source-paths', 'git', ['-C', dir, 'ls-files', '-z']).split('\0').filter(Boolean)
  const extra = run('source-extra-paths', 'git', ['-C', dir, 'ls-files', '--others', '--exclude-standard', '-z', 'apps', 'packages']).split('\0').filter(x => x.includes('/src/'))
  const rows = [...new Set([...tracked, ...extra])].sort().map(file => {
    requireThat(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'Unsafe source path')
    return [file, sha(fs.readFileSync(path.join(dir, file)))]
  })
  requireThat(rows.length > 0, 'Empty source observation')
  return sha(JSON.stringify(rows))
}
