import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLogs, createDb, createTempDatabase, sessions, type Database, type TempDatabase } from '@wsm/db'
import { eq } from 'drizzle-orm'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

let tmp: TempDatabase
let db: Database
let app: ReturnType<typeof createApp>
let source: string
let target: string
const auth = { authorization: 'Bearer router-test' }
const json = (method: string, body: unknown) => ({ method, headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_router_api' })
  db = createDb(tmp.url)
  const rows = await db.insert(sessions).values([{ name: 'A', phone: '+5511999990001' }, { name: 'B', phone: '+5511999990002' }]).returning()
  source = rows[0]!.id
  target = rows[1]!.id
  app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: 'router-test' })
})
afterAll(async () => { await db?.$client.end(); await tmp?.drop() })

describe('session links API', () => {
  it('exige autenticação para ler e alterar vínculos', async () => {
    expect((await app.request('/api/session-links')).status).toBe(401)
    expect((await app.request('/api/session-links', { method: 'POST' })).status).toBe(401)
    expect((await app.request('/api/session-links/runs')).status).toBe(401)
  })
  it('cria desativado, lista, habilita/desabilita, audita e exclui', async () => {
    const response = await app.request('/api/session-links', json('POST', { sourceSessionId: source, targetSessionId: target, rules: { matchText: 'oi', replyText: 'Olá!' } }))
    expect(response.status).toBe(201)
    const link = await response.json() as { id: string; enabled: boolean }
    expect(link.enabled).toBe(false)
    expect(await (await app.request('/api/session-links', { headers: auth })).json()).toMatchObject({ items: [link] })
    for (const enabled of [true, false]) {
      const result = await app.request(`/api/session-links/${link.id}`, json('PATCH', { enabled }))
      expect(result.status).toBe(200)
      expect(await result.json()).toMatchObject({ enabled })
    }
    expect(await db.select().from(auditLogs).where(eq(auditLogs.targetId, link.id))).toHaveLength(3)
    expect((await app.request(`/api/session-links/${link.id}`, { method: 'DELETE', headers: auth })).status).toBe(204)
    expect((await app.request(`/api/session-links/${link.id}`, json('PATCH', { enabled: true }))).status).toBe(404)
  })
  it('rejeita autorreferência, sessão inexistente, texto vazio, enabled na criação e ID inválido', async () => {
    const input = { sourceSessionId: source, targetSessionId: target, rules: { matchText: 'oi', replyText: 'Olá!' } }
    for (const invalid of [{ ...input, targetSessionId: source }, { ...input, enabled: true }, { ...input, rules: { matchText: ' ', replyText: 'oi' } }]) {
      expect((await app.request('/api/session-links', json('POST', invalid))).status).toBe(400)
    }
    expect((await app.request('/api/session-links', json('POST', { ...input, targetSessionId: '00000000-0000-4000-8000-000000000001' }))).status).toBe(404)
    expect((await app.request('/api/session-links/invalid', json('PATCH', { enabled: true }))).status).toBe(400)
  })
})
