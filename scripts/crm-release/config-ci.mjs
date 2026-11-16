// Real Compose merge check on the GitHub runner; no services are started here.
import fs from 'node:fs'
import path from 'node:path'
import { TREE, command, read, specFor, override, composeArgs, validateConfig, atomic } from './lib.mjs'
import { invoke } from './compose.mjs'
if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Compose model verification is CI-only')
const [repo, artifact, state] = process.argv.slice(2), m = read(path.join(artifact, 'release.json'))
const spec = specFor(m, 'ci_preserved_storage'), dir = path.join(state, 'releases', m.release)
fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'override.yml'), override(spec))
const base = JSON.parse(command('base-config', 'docker', [...composeArgs(repo, state), 'config', '--format', 'json']))
atomic(path.join(state, 'active.json'), spec)
const candidate = JSON.parse(invoke(repo, state, ['config', '--format', 'json']))
validateConfig(base, candidate, spec)
if (candidate.services.worker.restart !== 'on-failure:3' || spec.source_tree !== TREE) throw Error('Principal worker recovery policy/tree mismatch')
// The installer still requires an empty gate. Explicit later activation must
// survive the persistent compose wrapper without changing image or mounts.
const activated = { ...spec, company_id: '11111111-1111-4111-8111-111111111111' }
fs.writeFileSync(path.join(dir, 'override.yml'), override(activated)); atomic(path.join(state, 'active.json'), activated)
const enabled = JSON.parse(invoke(repo, state, ['config', '--format', 'json']))
for (const name of ['crm-api', 'crm-worker']) {
  if (enabled.services[name].environment.SHARED_OFFERS_COMPANY_ID !== activated.company_id) throw Error('Activation did not persist for both services')
  enabled.services[name].environment.SHARED_OFFERS_COMPANY_ID = ''
}
validateConfig(base, enabled, spec)
fs.writeFileSync(path.join(dir, 'override.yml'), override(spec)); atomic(path.join(state, 'active.json'), spec)
fs.writeFileSync(path.join(process.env.CRM_REPORT_DIR, 'compose-model.json'), JSON.stringify({ actual_compose_merge: true, persistent_override: true, gate_empty: true, explicit_company_activation_persists: true, isolated_musl_dependencies: true, shared_storage_preserved: true, future_web_build_copies_ci_spa_only: true, principal_restart_bounded: true }, null, 2))
