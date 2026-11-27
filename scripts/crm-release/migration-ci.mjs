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
  const a = await create(), c = await create()
  let b = await create()
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
  const connectionB = (await q("INSERT INTO crm.connections(company_id,session_id,name) VALUES($1,$2,'second fake chip') RETURNING id", [company, randomUUID()])).rows[0].id
  const flow = (await q("INSERT INTO crm.flows(company_id,name) VALUES($1,'legacy fixture') RETURNING id", [company])).rows[0].id
  const rows = []
  for (let i = 0; i < 2; i++) {
    const contact = (await q('INSERT INTO crm.contacts(company_id,name) VALUES($1,$2) RETURNING id', [company, 'Contact ' + i])).rows[0].id
    const chat = (await q('INSERT INTO crm.chats(company_id,contact_id,connection_id) VALUES($1,$2,$3) RETURNING id', [company, contact, i === 0 ? connection : connectionB])).rows[0].id
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
  await migrateUrl(b.url, { set: 'crm', folders: { crm:partial(43) } })
  const prefix43=(await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows
  assert.equal(prefix43.length,43)
  const beforeAreas=path.join(dir,'before0043.dump')
  utility('pg_dump',['-Fc','--no-owner','--dbname',b.url,'-f',beforeAreas]);utility('pg_restore',['--list',beforeAreas])
  metrics.before0043_backup_bytes=fs.statSync(beforeAreas).size
  const restored43=await create();utility('pg_restore',['--no-owner','--exit-on-error','--dbname',restored43.url,beforeAreas]);b=restored43
  await migrateUrl(b.url, { set: 'crm', folders: { crm: partial(44) } })
  const prefix44 = (await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows
  assert.equal(prefix44.length, 44)
  const waId = 'WA-migration-fixture'
  await b.client.query("INSERT INTO crm.messages(company_id,chat_id,direction,sender_type,type,status,wa_message_id) VALUES($1,$2,'outbound','user','text','delivered',$3)", [company, rows[0].chat, waId])
  await assert.rejects(b.client.query("INSERT INTO crm.messages(company_id,chat_id,direction,sender_type,type,status,wa_message_id) VALUES($1,$2,'inbound','contact','text','received',$3)", [company, rows[1].chat, waId]), e=>e.code==='23505')
  const beforeIdentity = path.join(dir, 'before0044.dump')
  utility('pg_dump', ['-Fc', '--no-owner', '--dbname', b.url, '-f', beforeIdentity]); utility('pg_restore', ['--list', beforeIdentity])
  const restored44 = await create(); utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', restored44.url, beforeIdentity]); b = restored44
  await migrateUrl(b.url, { set: 'crm', folders: { crm: partial(45) } })
  const journal45 = (await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows
  assert.equal(journal45.length, 45)
  assert.deepEqual(journal45.slice(0,44),prefix44)
  assert.deepEqual(journal45.slice(0,43),prefix43)
  assert.equal((await b.client.query('SELECT count(*)::int n FROM crm.business_areas')).rows[0].n,0)
  assert.equal((await b.client.query('SELECT business_area_id FROM crm.offers WHERE id=$1',[offer])).rows[0].business_area_id,null)
  const waIndexes = (await b.client.query("SELECT indexname FROM pg_indexes WHERE schemaname='crm' AND indexname IN ('messages_company_connection_wa_id_uq','messages_company_wa_id_uq')")).rows
  assert.deepEqual(waIndexes.map(x=>x.indexname), ['messages_company_connection_wa_id_uq'])
  await b.client.query("INSERT INTO crm.messages(company_id,chat_id,direction,sender_type,type,status,wa_message_id) VALUES($1,$2,'inbound','contact','text','received',$3)", [company, rows[1].chat, waId])
  await assert.rejects(b.client.query("INSERT INTO crm.messages(company_id,chat_id,direction,sender_type,type,status,wa_message_id) VALUES($1,$2,'inbound','contact','text','received',$3)", [company, rows[1].chat, waId]), e=>e.code==='23505')
  assert.equal((await b.client.query('SELECT count(*)::int n FROM crm.messages WHERE company_id=$1 AND wa_message_id=$2', [company,waId])).rows[0].n, 2)
  const identity = (await b.client.query('SELECT connection_id,chat_id FROM crm.messages WHERE company_id=$1 AND wa_message_id=$2 ORDER BY chat_id', [company,waId])).rows
  assert.deepEqual(new Set(identity.map(x=>x.connection_id)),new Set([connection,connectionB]))
  await assert.rejects(b.client.query('UPDATE crm.messages SET connection_id=$1 WHERE chat_id=$2',[connectionB,rows[0].chat]),e=>e.code==='23503')
  await assert.rejects(b.client.query('UPDATE crm.chats SET connection_id=$1 WHERE id=$2',[connectionB,rows[0].chat]),e=>e.code==='23503')
  const beforeStatus = path.join(dir, 'before0045.dump')
  utility('pg_dump', ['-Fc', '--no-owner', '--dbname', b.url, '-f', beforeStatus]); utility('pg_restore', ['--list', beforeStatus])
  const restored45 = await create(); utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', restored45.url, beforeStatus]); b = restored45
  await migrateUrl(b.url, { set: 'crm', folders: { crm: partial(46) } })
  const journal46 = (await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows
  assert.equal(journal46.length,46)
  assert.deepEqual(journal46.slice(0,45),journal45)
  assert.equal((await b.client.query('SELECT count(*)::int n FROM crm.pending_message_status')).rows[0].n,0)
  const pendingPipeline = randomUUID()
  await b.client.query("INSERT INTO crm.pending_message_status(company_id,connection_id,pipeline_message_id,status) VALUES($1,$2,$3,'delivered')",[company,connection,pendingPipeline])
  await assert.rejects(b.client.query("INSERT INTO crm.pending_message_status(company_id,connection_id,pipeline_message_id,status) VALUES($1,$2,$3,'read')",[company,connection,pendingPipeline]),e=>e.code==='23505')
  await assert.rejects(b.client.query("INSERT INTO crm.pending_message_status(company_id,connection_id,pipeline_message_id,status) VALUES($1,$2,$3,'read')",[randomUUID(),connection,randomUUID()]),e=>e.code==='23503')
  metrics.before0045_backup_bytes=fs.statSync(beforeStatus).size
  const workspace = (await b.client.query("INSERT INTO crm.business_areas(company_id,slot,name) VALUES($1,1,'Workspace test') RETURNING id", [company])).rows[0].id
  await b.client.query("INSERT INTO crm.business_area_resources(company_id,area_id,kind,resource_id) VALUES($1,$2,'flow',$3)", [company,workspace,flow])
  const beforeSharing = path.join(dir, 'before0046.dump')
  utility('pg_dump', ['-Fc', '--no-owner', '--dbname', b.url, '-f', beforeSharing]); utility('pg_restore', ['--list', beforeSharing])
  const restored46 = await create(); utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', restored46.url, beforeSharing]); b = restored46
  await migrateUrl(b.url, { set: 'crm', folders: { crm: partial(47) } })
  const journal47 = (await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows
  assert.equal(journal47.length,47)
  assert.deepEqual(journal47.slice(0,46),journal46)
  const sharing = await b.client.query("SELECT area_id,shared_with_workspaces FROM crm.business_area_resources WHERE company_id=$1 AND kind='flow' AND resource_id=$2", [company,flow])
  assert.deepEqual(sharing.rows, [{ area_id: workspace, shared_with_workspaces: false }])
  const { rows: [legacyProfile] } = await b.client.query("INSERT INTO crm.meta_profiles(company_id,fb_user_id,access_token_enc) VALUES($1,'fixture-fb','opaque-fixture') RETURNING id", [company])
  const { rows: [legacyAccount] } = await b.client.query("INSERT INTO crm.meta_ad_accounts(company_id,profile_id,fb_account_id) VALUES($1,$2,'act_100001') RETURNING id", [company, legacyProfile.id])
  const { rows: [legacyPixel] } = await b.client.query("INSERT INTO crm.pixel_configs(company_id,pixel_id,name,access_token_enc,auto_send_sales) VALUES($1,'100002','Legacy fixture','opaque-fixture',true) RETURNING id", [company])
  const beforeMeta = path.join(dir, 'before0047.dump')
  utility('pg_dump', ['-Fc', '--no-owner', '--dbname', b.url, '-f', beforeMeta]); utility('pg_restore', ['--list', beforeMeta])
  const restored47 = await create(); utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', restored47.url, beforeMeta]); b = restored47
  await migrateUrl(b.url, { set: 'crm', folders: { crm: partial(48) } })
  const journal48 = (await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows
  assert.equal(journal48.length,48)
  assert.deepEqual(journal48.slice(0,47),journal47)
  assert.deepEqual((await b.client.query('SELECT business_area_id,access_token_enc FROM crm.meta_profiles WHERE id=$1',[legacyProfile.id])).rows,[{business_area_id:null,access_token_enc:'opaque-fixture'}])
  assert.deepEqual((await b.client.query('SELECT business_area_id,profile_id FROM crm.meta_ad_accounts WHERE id=$1',[legacyAccount.id])).rows,[{business_area_id:null,profile_id:legacyProfile.id}])
  assert.deepEqual((await b.client.query('SELECT business_area_id,meta_ad_account_id,auto_send_sales FROM crm.pixel_configs WHERE id=$1',[legacyPixel.id])).rows,[{business_area_id:null,meta_ad_account_id:null,auto_send_sales:true}])
  const { rows: [otherArea] } = await b.client.query("INSERT INTO crm.business_areas(company_id,slot,name) VALUES($1,2,'Other workspace fixture') RETURNING id", [company])
  const addProfile = area => b.client.query("INSERT INTO crm.meta_profiles(company_id,business_area_id,fb_user_id,access_token_enc) VALUES($1,$2,'fixture-fb','opaque-fixture') RETURNING id", [company,area])
  const { rows: [profileA] } = await addProfile(workspace)
  const { rows: [profileB] } = await addProfile(otherArea.id)
  const addAccount = (area, profile, fbId) => b.client.query('INSERT INTO crm.meta_ad_accounts(company_id,business_area_id,profile_id,fb_account_id) VALUES($1,$2,$3,$4) RETURNING id', [company,area,profile,fbId])
  const { rows: [accountA] } = await addAccount(workspace,profileA.id,'act_200001')
  await assert.rejects(addAccount(otherArea.id, profileB.id, 'act_200001'), e => e.code === '23505')
  await assert.rejects(addAccount(otherArea.id, profileA.id, 'act_200002'), e => e.code === '23503')
  const addPixel = (area, account, automatic) => b.client.query("INSERT INTO crm.pixel_configs(company_id,business_area_id,meta_ad_account_id,pixel_id,name,access_token_enc,auto_send_sales) VALUES($1,$2,$3,'200002','Scoped fixture','opaque-fixture',$4)", [company,area,account,automatic])
  await assert.rejects(addPixel(otherArea.id,accountA.id,false), e => e.code === '23503')
  await assert.rejects(addPixel(workspace,accountA.id,true), e => e.code === '23514')
  await addPixel(workspace,accountA.id,false)
  const beforePixelPolicy = path.join(dir, 'before0048.dump')
  utility('pg_dump', ['-Fc', '--no-owner', '--dbname', b.url, '-f', beforePixelPolicy]); utility('pg_restore', ['--list', beforePixelPolicy])
  const restored48 = await create()
  utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', restored48.url, beforePixelPolicy]); b = restored48
  await migrateUrl(b.url, { set: 'crm', folders: { crm: partial(49) } })
  const journalAfter = (await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows
  assert.equal(journalAfter.length,49)
  assert.deepEqual(journalAfter.slice(0,48),journal48)
  const policy = await b.client.query('SELECT allowed_events FROM crm.pixel_configs WHERE id=$1 OR (business_area_id=$2 AND meta_ad_account_id=$3)', [legacyPixel.id,workspace,accountA.id])
  assert.deepEqual(policy.rows.map(x => x.allowed_events), [['Purchase'], ['Purchase']])
  await assert.rejects(b.client.query("UPDATE crm.pixel_configs SET allowed_events=ARRAY['Invalid'] WHERE id=$1", [legacyPixel.id]), e => e.code === '23514')
  await migrateUrl(b.url, { set: 'crm', folders: { crm: partial(49) } }); assert.deepEqual((await b.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows, journalAfter)
  assert.equal((await b.client.query('SELECT count(*)::int n FROM crm.company_members')).rows[0].n, 3)
  assert.equal((await b.client.query('SELECT count(*)::int n FROM crm.release_fixture_link JOIN public.release_fixture_parent ON parent_id=id')).rows[0].n, 1)
  const scope = (await b.client.query('SELECT id,offer_scoped FROM crm.flow_runs ORDER BY id')).rows
  assert.equal(scope.find(x => x.id === rows[0].run).offer_scoped, false); assert.equal(scope.find(x => x.id === rows[1].run).offer_scoped, true)
  const indexes = (await b.client.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='crm' AND indexname IN ('flow_runs_active_contact_uq','flow_runs_active_chat_uq')")).rows
  assert.equal(indexes.length, 2); assert.ok(indexes.some(x => x.indexname === 'flow_runs_active_contact_uq' && x.indexdef.includes('NOT offer_scoped')))
  await assert.rejects(b.client.query('UPDATE crm.flow_runs SET offer_scoped=true WHERE id=$1', [rows[0].run]), /invalid offer run scope/)
  await assert.rejects(b.client.query("INSERT INTO crm.flow_runs(company_id,flow_id,contact_id,chat_id,status) VALUES($1,$2,$3,$4,'running')", [company, flow, rows[0].contact, rows[0].chat]), e => e.code === '23505')
  await assert.rejects(b.client.query('DELETE FROM public.release_fixture_parent WHERE id=$1', [parent]), e => e.code === '23503')
  // Legacy company/chat mismatch must fail closed, not backfill from another tenant.
  await migrateUrl(a.url, { set: 'crm', folders: { crm: partial(44) } })
  const badCompany = (await a.client.query("INSERT INTO crm.companies(name,slug) VALUES('Mismatch fixture',$1) RETURNING id", ['bad-' + randomUUID()])).rows[0].id
  await a.client.query("INSERT INTO crm.messages(company_id,chat_id,direction,sender_type,type,status) VALUES($1,$2,'inbound','contact','text','received')", [badCompany,rows[0].chat])
  await assert.rejects(migrateUrl(a.url, { set: 'crm' }), e=>(e.cause?.code ?? e.code)==='P0001')
  assert.equal((await a.client.query('SELECT count(*)::int n FROM crm.__drizzle_migrations')).rows[0].n,44)
  assert.equal((await a.client.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='crm' AND table_name='messages' AND column_name='connection_id'")).rows[0].n,0)
  const finalDump = path.join(dir, 'after0048.dump'); utility('pg_dump', ['-Fc', '--no-owner', '--dbname', b.url, '-f', finalDump]); utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', c.url, finalDump])
  assert.deepEqual((await c.client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows, journalAfter)
  assert.deepEqual((await c.client.query('SELECT id,offer_scoped FROM crm.flow_runs ORDER BY id')).rows, scope)
  await assert.rejects(c.client.query('UPDATE crm.flow_runs SET offer_scoped=true WHERE id=$1', [rows[0].run]), /invalid offer run scope/)
  assert.equal((await c.client.query('SELECT count(*)::int n FROM crm.messages WHERE company_id=$1 AND wa_message_id=$2', [company,waId])).rows[0].n, 2)
  assert.equal((await c.client.query('SELECT count(*)::int n FROM crm.pending_message_status')).rows[0].n,1)
  // CRM-003 A6: 0049 aborts atomically on dependent offer activity. The historical fixture keeps its active
  // offer-scoped run (rows[1]); nothing is cancelled. The whole migration must roll back with an explanatory error.
  const offerSchema = async client => (await client.query("SELECT json_build_object('trigger',EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='validate_offer_run_scope'),'indexes',(SELECT count(*)::int FROM pg_indexes WHERE schemaname='crm' AND indexname IN ('flow_runs_active_contact_uq','flow_runs_active_chat_uq')),'frozen',(SELECT count(*)::int FROM pg_trigger WHERE tgname='offer_legacy_frozen' AND NOT tgisinternal)) s")).rows[0].s
  const crmJournal = async client => (await client.query('SELECT hash,created_at FROM crm.__drizzle_migrations ORDER BY created_at')).rows
  const before49 = path.join(dir, 'before0049.dump'); utility('pg_dump', ['-Fc', '--no-owner', '--dbname', b.url, '-f', before49]); utility('pg_restore', ['--list', before49])
  const blocked = await create(); utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', blocked.url, before49])
  const blockedRuns = (await blocked.client.query('SELECT id,status,offer_scoped FROM crm.flow_runs ORDER BY id')).rows
  assert.ok(blockedRuns.some(x => x.offer_scoped && ['running', 'waiting'].includes(x.status)), 'fixture must keep an active offer-scoped run')
  await assert.rejects(migrateUrl(blocked.url, { set: 'crm' }), e => (e.cause?.code ?? e.code) === 'P0001' && String(e.cause?.message ?? e.message).includes('migração 0049 abortada: 1 run(s) de fluxo de oferta'))
  assert.deepEqual(await crmJournal(blocked.client), journalAfter)
  assert.deepEqual(await offerSchema(blocked.client), { trigger: true, indexes: 2, frozen: 0 })
  assert.deepEqual((await blocked.client.query('SELECT id,status,offer_scoped FROM crm.flow_runs ORDER BY id')).rows, blockedRuns)
  await assert.rejects(migrateUrl(blocked.url, { set: 'crm' }), e => (e.cause?.code ?? e.code) === 'P0001')
  assert.deepEqual(await crmJournal(blocked.client), journalAfter)
  // Upgrade 49->50 without dependent activity: legacy offer history stays readable and frozen; one active run per contact.
  const clean = await create()
  await migrateUrl(clean.url, { set: 'wa' }); await migrateUrl(clean.url, { set: 'crm', folders: { crm: partial(49) } })
  assert.deepEqual(await crmJournal(clean.client), journalAfter)
  const cq = (sql, args) => clean.client.query(sql, args)
  const cleanCompany = (await cq("INSERT INTO crm.companies(name,slug) VALUES('CI retire offers',$1) RETURNING id", ['retire-' + randomUUID()])).rows[0].id
  const cleanConnection = (await cq("INSERT INTO crm.connections(company_id,session_id,name) VALUES($1,$2,'previously managed fake chip') RETURNING id", [cleanCompany, randomUUID()])).rows[0].id
  const cleanFlow = (await cq("INSERT INTO crm.flows(company_id,name) VALUES($1,'ordinary flow') RETURNING id", [cleanCompany])).rows[0].id
  const cleanContact = (await cq("INSERT INTO crm.contacts(company_id,name) VALUES($1,'Ordinary contact') RETURNING id", [cleanCompany])).rows[0].id
  const cleanConnection2 = (await cq("INSERT INTO crm.connections(company_id,session_id,name) VALUES($1,$2,'second fake chip') RETURNING id", [cleanCompany, randomUUID()])).rows[0].id
  // One chat per contact and connection: the second chat of the same contact uses the second chip.
  const chatOf = async conn => (await cq('INSERT INTO crm.chats(company_id,contact_id,connection_id) VALUES($1,$2,$3) RETURNING id', [cleanCompany, cleanContact, conn])).rows[0].id
  const cleanChat = await chatOf(cleanConnection), cleanChat2 = await chatOf(cleanConnection2)
  const cleanRun = (await cq("INSERT INTO crm.flow_runs(company_id,flow_id,contact_id,chat_id,status,trigger) VALUES($1,$2,$3,$4,'waiting','{}') RETURNING id", [cleanCompany, cleanFlow, cleanContact, cleanChat])).rows[0].id
  const legacyOffer = (await cq("INSERT INTO crm.offers(company_id,name,config) VALUES($1,'legacy offer history','{}') RETURNING id", [cleanCompany])).rows[0].id
  await migrateUrl(clean.url, { set: 'crm' })
  const journal50 = await crmJournal(clean.client)
  assert.equal(journal50.length, 50); assert.deepEqual(journal50.slice(0, 49), journalAfter)
  assert.deepEqual(await offerSchema(clean.client), { trigger: false, indexes: 1, frozen: 5 })
  assert.deepEqual((await cq('SELECT id,name FROM crm.offers WHERE company_id=$1', [cleanCompany])).rows, [{ id: legacyOffer, name: 'legacy offer history' }])
  await assert.rejects(cq("INSERT INTO crm.offers(company_id,name,config) VALUES($1,'new offer','{}')", [cleanCompany]), /offer_legacy_frozen/)
  await assert.rejects(cq("UPDATE crm.offers SET name='changed' WHERE id=$1", [legacyOffer]), /offer_legacy_frozen/)
  assert.equal((await cq('SELECT status FROM crm.flow_runs WHERE id=$1', [cleanRun])).rows[0].status, 'waiting')
  await assert.rejects(cq("INSERT INTO crm.flow_runs(company_id,flow_id,contact_id,chat_id,status) VALUES($1,$2,$3,$4,'running')", [cleanCompany, cleanFlow, cleanContact, cleanChat2]), e => e.code === '23505')
  await migrateUrl(clean.url, { set: 'crm' }); assert.deepEqual(await crmJournal(clean.client), journal50)
  const after49 = path.join(dir, 'after0049.dump'); utility('pg_dump', ['-Fc', '--no-owner', '--dbname', clean.url, '-f', after49])
  const restored50 = await create(); utility('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', restored50.url, after49])
  assert.deepEqual(await crmJournal(restored50.client), journal50)
  assert.deepEqual(await offerSchema(restored50.client), { trigger: false, indexes: 1, frozen: 5 })
  await assert.rejects(restored50.client.query("INSERT INTO crm.offers(company_id,name,config) VALUES($1,'after restore','{}')", [cleanCompany]), /offer_legacy_frozen/)
  metrics.passed = ['CRM-003 0049 aborts atomically on an active offer-scoped run without cancelling it (journal 49, schema and runs unchanged, retry still aborts)', 'CRM-003 upgrade 49->50 preserves 49-prefix and legacy offer rows, freezes offer tables, drops offer guards, one active run per contact, idempotent rerun and dump/restore', 'backup/restore0038 with public dependency', 'one shared company and three existing member identities preserved', '0039->0042 valid opportunity backfill and legacy scope', 'backup/restore0042 then upgrade0043 without changing43-prefix or assigning existing offers', 'backup/restore44 then upgrade45 preserving44-prefix and old outbound', 'two connections may contain same WA id; local duplicate and identity moves rejected', 'backup/restore45 then upgrade46 preserving45-prefix and status-only tenant FK', 'backup/restore46 then upgrade47 retaining private flow ownership and exact prefix', 'backup/restore48 and upgrade49 preserves prefix and limits legacy and scoped pixels to Purchase', '49-entry journal idempotence', 'unique indexes and scope/FK triggers', 'post0046 dump/restore with pending receipt', 'RPO tail-loss demonstrated without automatic production restore']
  fs.writeFileSync(path.join(process.env.CRM_REPORT_DIR, 'migration-restore.json'), JSON.stringify(metrics, null, 2))
} finally {
  for (const client of clients) await client.end()
  for (const name of names) { assert.match(name, /^crm_release_ci_[a-f0-9]+$/); await admin.query(`DROP DATABASE IF EXISTS "${name}"`) }
  await admin.end()
}
