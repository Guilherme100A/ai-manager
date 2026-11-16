// Actual PostgreSQL dump/restore rehearsal ONLY on GitHub's disposable service.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { pgClientUtility, pg16Versions } from './pg-client-ci.mjs'
const source = path.resolve(process.argv[2] ?? ''), url = new URL(process.env.DATABASE_URL ?? 'http://invalid')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This rehearsal runs only in CI, never on an operator PC/VPS')
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'postgres:')
const { default: pg } = await import(pathToFileURL(createRequire(path.join(source, 'packages/db/package.json')).resolve('pg')).href)
const { migrateUrl } = await import(pathToFileURL(path.join(source, 'packages/db/src/client.ts')).href)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-release-rehearsal-'))
const journalRoot = path.join(source, 'packages/db/drizzle/crm'), journal = JSON.parse(fs.readFileSync(path.join(journalRoot, 'meta/_journal.json')))
const partial = count => {
  const folder = path.join(dir, 'migrations-' + count); fs.mkdirSync(path.join(folder, 'meta'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }))
  for (const m of journal.entries.slice(0, count)) fs.copyFileSync(path.join(journalRoot, m.tag + '.sql'), path.join(folder, m.tag + '.sql'))
  return folder
}
const admin = new pg.Client({ connectionString: url.href }), clients = [], names = []
const withDb = name => { const u = new URL(url); u.pathname = '/' + name; return u.href }
const create = async () => { const name = 'crm_release_ci_' + randomUUID().replaceAll('-', ''); names.push(name); await admin.query(`CREATE DATABASE "${name}"`); const client = new pg.Client({ connectionString: withDb(name) }); await client.connect(); clients.push(client); return { name, client, url: withDb(name) } }
const pgContainer = process.env.CRM_CI_POSTGRES_CONTAINER
assert.match(pgContainer ?? '', /^[a-f0-9]{12,64}$/)
const utility = (cmd, args) => pgClientUtility(pgContainer, cmd, args)
const metrics = { fixture: 'synthetic only: actual WA/public migrations, three members in one company, shared connection/chats, legacy runs and explicit cross-schema FK', production_restore: false }
await admin.connect()
try {
  const version = command => { const r = spawnSync('docker', ['exec', pgContainer, command, '--version'], { encoding: 'utf8' }); assert.equal(r.status, 0, 'CI PostgreSQL version probe failed'); return r.stdout.trim() }
  metrics.client_versions = pg16Versions(version('pg_dump'), version('pg_restore'), (await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  const a = await create(), b = await create(), c = await create()
  await migrateUrl(a.url, { set: 'wa' })
  await migrateUrl(a.url, { set: 'crm', folders: { crm: partial(39) } })
  const q = (sql, args) => a.client.query(sql, args)
  const company = (await q("INSERT INTO crm.companies(name,slug) VALUES('CI shared company',$1) RETURNING id", ['ci-' + randomUUID()])).rows[0].id
  for (let i = 0; i < 3; i++) {
    const user = (await q("INSERT INTO crm.users(name,email,password_hash) VALUES($1,$2,'synthetic-not-login') RETURNING id", ['Admin ' + i, `admin-${i}-${randomUUID()}@example.test`])).rows[0].id
    await q('INSERT INTO crm.company_members(company_id,user_id,role) VALUES($1,$2,$3)', [company, user, i === 0 ? 'owner' : 'admin'])
  }
  await q('CREATE TABLE public.release_fixture_parent(id uuid PRIMARY KEY, payload text NOT NULL)')
  await q('CREATE TABLE crm.release_fixture_link(company_id uuid REFERENCES crm.companies(id), parent_id uuid REFERENCES public.release_fixture_parent(id))')
  const parent = randomUUID(); await q("INSERT INTO public.release_fixture_parent VALUES($1,'before backup')", [parent]); await q('INSERT INTO crm.release_fixture_link VALUES($1,$2)', [company, parent])
  const connection = (await q("INSERT INTO crm.connections(company_id,session_id,name) VALUES($1,$2,'shared fake chip') RETURNING id", [company, randomUUID()])).rows[0].id
  const flow = (await q("INSERT INTO crm.flows(company_id,name) VALUES($1,'legacy fixture') RETURNING id", [company])).rows[0].id
  const rows = []
  for (let i = 0; i < 2; i++) {
    const contact = (await q('INSERT INTO crm.contacts(company_id,name) VALUES($1,$2) RETURNING id', [company, 'Contact ' + i])).rows[0].id
    const chat = (await q('INSERT INTO crm.chats(company_id,contact_id,connection_id) VALUES($1,$2,$3) RETURNING id', [company, contact, connection])).rows[0].id
    const run = (await q("INSERT INTO crm.flow_runs(company_id,flow_id,contact_id,chat_id,status,trigger) VALUES($1,$2,$3,$4,'waiting','{}') RETURNING id", [company, flow, contact, chat])).rows[0].id
    rows.push({ contact, chat, run })
  }
  const first = path.join(dir, 'before0039.dump'), before = performance.now()
  utility('pg_dump', ['-Fc', '--no-owner', '--dbname', a.url, '-f', first]); utility('pg_restore', ['--list', first])
  metrics.backup_ms = performance.now() - before; metrics.backup_bytes = fs.statSync(first).size
  await q("INSERT INTO public.release_fixture_parent VALUES($1,'after backup; intentionally outside RPO')", [randomUUID()])
  const restoreStart = performance.now(); utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', b.url, first]); metrics.restore_ms = performance.now() - restoreStart
  assert.equal((await b.client.query('SELECT count(*)::int n FROM public.release_fixture_parent')).rows[0].n, 1)
  assert.equal((await q('SELECT count(*)::int n FROM public.release_fixture_parent')).rows[0].n, 2)
  metrics.demonstrated_rpo_missing_tail_rows = 1
  // Stage one valid opportunity before 0042 to prove backfill; another legacy run remains unscoped.
  await migrateUrl(b.url, { set: 'crm', folders: { crm: partial(40) } })
  const offer = (await b.client.query("INSERT INTO crm.offers(company_id,name,config) VALUES($1,'synthetic offer','{}') RETURNING id", [company])).rows[0].id
  const op = (await b.client.query("INSERT INTO crm.offer_opportunities(company_id,offer_id,contact_id,chat_id,snapshot,evidence) VALUES($1,$2,$3,$4,'{}','{}') RETURNING id", [company, offer, rows[1].contact, rows[1].chat])).rows[0].id
  await b.client.query('UPDATE crm.flow_runs SET trigger=$1 WHERE id=$2', [JSON.stringify({ opportunity_id: op }), rows[1].run])
  await migrateUrl(b.url, { set: 'crm' })
  const journalAfter = (await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows
  assert.equal(journalAfter.length, 43)
  await migrateUrl(b.url, { set: 'crm' }); assert.deepEqual((await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows, journalAfter)
  assert.equal((await b.client.query('SELECT count(*)::int n FROM crm.company_members')).rows[0].n, 3)
  assert.equal((await b.client.query('SELECT count(*)::int n FROM crm.release_fixture_link JOIN public.release_fixture_parent ON parent_id=id')).rows[0].n, 1)
  const scope = (await b.client.query('SELECT id,offer_scoped FROM crm.flow_runs ORDER BY id')).rows
  assert.equal(scope.find(x => x.id === rows[0].run).offer_scoped, false); assert.equal(scope.find(x => x.id === rows[1].run).offer_scoped, true)
  const indexes = (await b.client.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='crm' AND indexname IN ('flow_runs_active_contact_uq','flow_runs_active_chat_uq')")).rows
  assert.equal(indexes.length, 2); assert.ok(indexes.some(x => x.indexname === 'flow_runs_active_contact_uq' && x.indexdef.includes('NOT offer_scoped')))
  await assert.rejects(b.client.query('UPDATE crm.flow_runs SET offer_scoped=true WHERE id=$1', [rows[0].run]), /invalid offer run scope/)
  await assert.rejects(b.client.query("INSERT INTO crm.flow_runs(company_id,flow_id,contact_id,chat_id,status) VALUES($1,$2,$3,$4,'running')", [company, flow, rows[0].contact, rows[0].chat]), e => e.code === '23505')
  await assert.rejects(b.client.query('DELETE FROM public.release_fixture_parent WHERE id=$1', [parent]), e => e.code === '23503')
  const finalDump = path.join(dir, 'after0042.dump'); utility('pg_dump', ['-Fc', '--no-owner', '--dbname', b.url, '-f', finalDump]); utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', c.url, finalDump])
  assert.deepEqual((await c.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows, journalAfter)
  assert.deepEqual((await c.client.query('SELECT id,offer_scoped FROM crm.flow_runs ORDER BY id')).rows, scope)
  await assert.rejects(c.client.query('UPDATE crm.flow_runs SET offer_scoped=true WHERE id=$1', [rows[0].run]), /invalid offer run scope/)
  metrics.passed = ['backup/restore0038 with public dependency', 'one shared company and three member identities preserved', '0039->0042 valid opportunity backfill and legacy scope', '43-entry journal idempotence', 'unique indexes and scope/FK triggers', 'post0042 dump/restore', 'RPO tail-loss demonstrated without automatic production restore']
  fs.writeFileSync(path.join(process.env.CRM_REPORT_DIR, 'migration-restore.json'), JSON.stringify(metrics, null, 2))
} finally {
  for (const client of clients) await client.end()
  for (const name of names) { assert.match(name, /^crm_release_ci_[a-f0-9]+$/); await admin.query(`DROP DATABASE IF EXISTS "${name}"`) }
  await admin.end()
}
