import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

// Creates a NEW checkout only. Never runs migrations, changes credentials, or starts services.
const packageDir = fileURLToPath(new URL('../integrations/shared-offers/', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(packageDir, 'manifest.json'), 'utf8'))
const destination = process.argv[2] && resolve(process.argv[2])
if (!destination || existsSync(destination)) throw new Error('Pass a destination that does not exist')
for (const item of manifest.patches) {
 const bytes = readFileSync(resolve(packageDir, item.file))
 if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Patch checksum mismatch: '+item.file)
}
mkdirSync(dirname(destination), { recursive: true })
const git = (...args) => execFileSync('git', args, { stdio: 'inherit' })
git('clone', '--no-checkout', manifest.repository, destination)
git('-C', destination, 'fetch', 'origin', manifest.base_sha)
git('-C', destination, 'checkout', '--detach', manifest.base_sha)
for (const item of manifest.patches) {
 const patch = resolve(packageDir, item.file)
 git('-C', destination, 'apply', '--check', patch)
 git('-C', destination, 'apply', patch)
}
git('-C', destination, 'add', '-A')
const tree = execFileSync('git', ['-C', destination, 'write-tree'], { encoding: 'utf8' }).trim()
if (tree !== manifest.expected_tree) throw new Error('Reconstructed distribution tree mismatch')
console.log('CRM reconstructed. Review patches, install dependencies, and test before any publication.')
