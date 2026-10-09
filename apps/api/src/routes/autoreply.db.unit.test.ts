// /api/autoreply-targets com Postgres local (banco descartável).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTOREPLY_CONSENT_SOURCE, type AutoReplyTarget } from '@wsm/core'
import { contacts, createDb, createTempDatabase, messages, sessions, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

const TOKEN = 'autoreply-token'
let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_autoreply' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

const req = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
  createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN }).request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })

describe('/api/autoreply-targets', () => {
  it('adiciona vários (com ou sem +), avisa inválidos, lista e remove', async () => {
    const add = await req('POST', '/api/autoreply-targets', { phones: ['5511999990001', '+55 (11) 99999-0002', '5511999990001', 'abc'] })
    expect(add.status).toBe(201)
    expect(await add.json()).toEqual({ added: ['+5511999990001', '+5511999990002'], invalid: ['abc'] })

    const list = (await (await req('GET', '/api/autoreply-targets')).json()) as { items: AutoReplyTarget[] }
    expect(list.items.map((t) => t.phone).sort()).toEqual(['+5511999990001', '+5511999990002'])
    expect(list.items[0]).toMatchObject({ sent24h: 0, replies24h: 0, lastSentAt: null })

    const [row] = await db.select().from(contacts).limit(1)
    expect(row).toMatchObject({ consent: true, consentSource: AUTOREPLY_CONSENT_SOURCE, optOut: false })

    expect((await req('DELETE', `/api/autoreply-targets/${list.items[0]!.id}`)).status).toBe(204)
    expect((await req('DELETE', `/api/autoreply-targets/${list.items[0]!.id}`)).status).toBe(404)
    const after = (await (await req('GET', '/api/autoreply-targets')).json()) as { items: AutoReplyTarget[] }
    expect(after.items).toHaveLength(1)
  })

  it('estatísticas contam só as mensagens de cada número', async () => {
    await req('POST', '/api/autoreply-targets', { phones: ['5511999990003', '5511999990004'] })
    const [s] = await db.insert(sessions).values({ name: 'chip', phone: '+5531900000000' }).returning()
    const msg = (phone: string, direction: 'outbound' | 'inbound') =>
      db.insert(messages).values({ sessionId: s!.id, phone, content: { text: 'x' }, direction, status: 'delivered' })
    await msg('+5511999990003', 'outbound')
    await msg('+5511999990003', 'outbound')
    await msg('+5511999990003', 'inbound')
    await msg('+5511888880000', 'outbound') // outro número, fora da lista
    const list = (await (await req('GET', '/api/autoreply-targets')).json()) as { items: AutoReplyTarget[] }
    const by = (phone: string) => list.items.find((t) => t.phone === phone)!
    expect(by('+5511999990003')).toMatchObject({ sent24h: 2, replies24h: 1 })
    expect(by('+5511999990003').lastSentAt).not.toBeNull()
    expect(by('+5511999990004')).toMatchObject({ sent24h: 0, replies24h: 0, lastSentAt: null })
  })

  it('não remove contato comum e exige autenticação', async () => {
    const [plain] = await db.insert(contacts).values({ phone: '+5511999990009', consent: true, consentSource: 'outro' }).returning()
    expect((await req('DELETE', `/api/autoreply-targets/${plain!.id}`)).status).toBe(404)
    expect((await req('GET', '/api/autoreply-targets', undefined, null)).status).toBe(401)
  })
})
