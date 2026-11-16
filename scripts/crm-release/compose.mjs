import fs from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { composeArgs, command, requireThat } from './lib.mjs'
export function invoke(repo, state, args, run = command) {
  requireThat(!fs.existsSync(resolve(state, 'maintenance.json')), 'CRM maintenance unresolved; operator reconciliation required')
  return run('persistent-compose', 'docker', [...composeArgs(repo, state), ...args], { timeout: 1_800_000 })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const [repo, state, ...args] = process.argv.slice(2); requireThat(repo && state && args.length, 'Missing Compose arguments'); invoke(resolve(repo), resolve(state), args) } catch (e) { console.error(e.message); process.exitCode = 1 }
}
