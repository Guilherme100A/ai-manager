// Contagem de mensagens por chip com Postgres local (banco descartável).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, messages, sessions, type Database, type TempDatabase } from '@wsm/db'
import { messageCountsBySession } from './message-counts'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_msgcount' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

describe('mensagens por chip', () => {
  it('conta enviadas (só as que saíram) e recebidas, no total e nas últimas 24 h', async () => {
    const now = new Date('2026-10-09T12:00:00Z')
    const [a] = await db.insert(sessions).values({ name: 'A', phone: '+5531900000001' }).returning()
    const [b] = await db.insert(sessions).values({ name: 'B', phone: '+5531900000002' }).returning()
    const msg = (sessionId: string, direction: 'outbound' | 'inbound', status: 'sent' | 'delivered' | 'read' | 'failed' | 'queued', hoursAgo: number) =>
      db.insert(messages).values({ sessionId, phone: '+5531999999999', content: { text: 'x' }, direction, status, createdAt: new Date(now.getTime() - hoursAgo * 3_600_000) })
    await msg(a!.id, 'outbound', 'delivered', 1)
    await msg(a!.id, 'outbound', 'read', 2)
    await msg(a!.id, 'outbound', 'sent', 30) // fora das 24 h
    await msg(a!.id, 'outbound', 'failed', 1) // falha não conta como enviada
    await msg(a!.id, 'outbound', 'queued', 1) // na fila não conta
    await msg(a!.id, 'inbound', 'delivered', 3)
    await msg(a!.id, 'inbound', 'delivered', 48)

    const counts = await messageCountsBySession(db, now)
    expect(counts[a!.id]).toEqual({ sentTotal: 3, receivedTotal: 2, sent24h: 2, received24h: 1 })
    expect(counts[b!.id]).toBeUndefined() // sem mensagens: o painel mostra 0
  })
})
