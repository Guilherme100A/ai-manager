import fs from 'node:fs'
import path from 'node:path'
import { TREE, command, hashFile, read, validateManifest } from './lib.mjs'
const [source, out, release] = process.argv.slice(2)
if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Artifact packaging runs in CI only')
const image = JSON.parse(command('image-metadata', 'docker', ['image', 'inspect', `crm-shared-offers:${release}`, '--format', '{{json .}}']))
if (image.Config?.Labels?.['crm.source-tree'] !== TREE) throw Error('Image source tree mismatch')
const migrations = read(path.join(source, 'packages/db/drizzle/crm/meta/_journal.json')).entries.map(m => ({ idx: m.idx, tag: m.tag, when: m.when, hash: hashFile(path.join(source, 'packages/db/drizzle/crm', m.tag + '.sql')) }))
const manifest = validateManifest({ format: 1, release, source_tree: TREE, image: `crm-shared-offers:${release}`, image_id: image.Id, runtime: 'node:22-alpine', platform: 'linux/amd64', images_sha256: hashFile(path.join(out, 'images.tar.gz')), spa_sha256: hashFile(path.join(out, 'spa.tar.gz')), migrations })
fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync(path.join(out, 'release.json.sha256'), hashFile(path.join(out, 'release.json')) + '  release.json\n')
