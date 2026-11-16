// Read-only observation. RPO acknowledgment intentionally defaults to false.
import path from 'node:path'
import { command, composeArgs, sourceDigest, requireThat } from './lib.mjs'
const [repoArg, legacyArg, stateArg, requiredBytes] = process.argv.slice(2)
try {
  requireThat([repoArg, legacyArg, stateArg].every(x => x && path.isAbsolute(x)), 'Absolute repository/legacy/state paths required')
  const args = composeArgs(repoArg, stateArg)
  const id = command('crm-api-id', 'docker', [...args, 'ps', '-q', 'crm-api'])
  const mounts = JSON.parse(command('storage', 'docker', ['inspect', '--format', '{{json .Mounts}}', id]))
  const storage = mounts.find(x => x.Type === 'volume' && x.Destination === '/data/storage')
  requireThat(storage?.Name && Number.isSafeInteger(Number(requiredBytes)) && Number(requiredBytes) > 0, 'Storage or backup/disk budget missing')
  console.log(JSON.stringify({ format: 1, observed_at: new Date().toISOString(), approved_panel_sha: command('panel-head', 'git', ['-C', repoArg, 'rev-parse', 'HEAD']), legacy_crm: legacyArg, crm_head: command('crm-head', 'git', ['-C', legacyArg, 'rev-parse', 'HEAD']), source_sha256: sourceDigest(legacyArg), storage_volume: storage.Name, required_free_bytes: Number(requiredBytes), ack_shared_database_rpo: false }, null, 2))
} catch (e) { console.error(e.message); process.exitCode = 1 }
