import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { requireThat } from './lib.mjs'
// Use the binaries from the SAME PostgreSQL16 service container, not Ubuntu PATH.
export function pgClientPlan(container, executable, original) {
  requireThat(/^[a-f0-9]{12,64}$/.test(container), 'CI PostgreSQL service container required')
  requireThat(['pg_dump', 'pg_restore'].includes(executable), 'Unexpected PostgreSQL utility')
  const args = [...original]; let inputFile, outputFile
  if (executable === 'pg_dump') {
    const i = args.indexOf('-f')
    requireThat(i >= 0 && path.isAbsolute(args[i + 1]), 'Absolute CI dump output required')
    outputFile = args[i + 1]; args.splice(i, 2)
  } else {
    inputFile = args.pop(); requireThat(path.isAbsolute(inputFile), 'Absolute CI restore input required')
  }
  return { executable: 'docker', args: ['exec', ...(inputFile ? ['-i'] : []), container, executable, ...args], inputFile, outputFile }
}
export function pg16Versions(dump, restore, server) {
  requireThat(/^pg_dump \(PostgreSQL\) 16\./.test(dump) && /^pg_restore \(PostgreSQL\) 16\./.test(restore) && Number(server) >= 160000 && Number(server) < 170000, 'PostgreSQL client/server16 contract failed')
  return { pg_dump: dump, pg_restore: restore, server_version_num: String(server), client_location: 'same postgres16 CI service container' }
}
export function pgClientUtility(container, executable, args) {
  requireThat(process.env.GITHUB_ACTIONS === 'true', 'PostgreSQL utility runs only in CI')
  const plan = pgClientPlan(container, executable, args), descriptors = []
  try {
    const stdin = plan.inputFile ? fs.openSync(plan.inputFile, 'r') : 'ignore'
    const stdout = plan.outputFile ? fs.openSync(plan.outputFile, 'wx', 0o600) : 'pipe'
    if (typeof stdin === 'number') descriptors.push(stdin)
    if (typeof stdout === 'number') descriptors.push(stdout)
    const r = spawnSync(plan.executable, plan.args, { stdio: [stdin, stdout, 'pipe'], timeout: 300_000 })
    requireThat(!r.error && r.status === 0, 'CI PostgreSQL utility failed; credentials withheld')
  } finally { for (const fd of descriptors) fs.closeSync(fd) }
}
