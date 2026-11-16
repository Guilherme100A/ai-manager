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
fs.writeFileSync(path.join(process.env.CRM_REPORT_DIR, 'compose-model.json'), JSON.stringify({ actual_compose_merge: true, persistent_override: true, gate_empty: true, isolated_musl_dependencies: true, shared_storage_preserved: true, future_web_build_copies_ci_spa_only: true, principal_restart_bounded: true }, null, 2))
