// HealthService com Postgres local (banco descartável) e relógio injetado.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, healthEvents, messages, sessions, type Database, type TempDatabase } from '@wsm/db'
import { DAY_MS } from '../warmup'
import { HealthService } from './service'

let tmp: TempDatabase
let db: Database
const NOW = new Date('2026-03-10T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const H = 60 * 60 * 1000

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_health' })
  db = createDb(tmp.url, { max: 4 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

beforeEach(async () => {
  await db.delete(sessions)
})

async function session(over: Partial<typeof sessions.$inferInsert> = {}) {
  const [row] = await db.insert(sessions).values({ name: 's', phone: '+5511999990001', status: 'WARMING', ...over }).returning()
  return row!
}

type MsgStatus = (typeof messages.$inferInsert)['status']
async function msg(sessionId: string, status: MsgStatus, createdAt: Date, direction: 'outbound' | 'inbound' = 'outbound') {
  await db.insert(messages).values({ sessionId, phone: '+5511999990002', content: { text: 'x' }, status, direction, createdAt })
}
async function ev(sessionId: string, type: string, createdAt: Date) {
  await db.insert(healthEvents).values({ sessionId, type, createdAt })
}

const service = () => new HealthService(db, { now: () => NOW })

describe('HealthService', () => {
  it('sessão sem sinais: 100/Good, warm-up pela idade', async () => {
    const s = await session({ warmupStartedAt: ago(3.5 * DAY_MS) })
    expect(await service().getHealth(s.id)).toEqual({
      state: 'WARMING',
      warmupPercent: 50,
      score: 100,
      label: 'Good',
      sent: 0,
      received: 0,
      failed: 0,
      disconnects: 0,
      forbidden403: 0,
      lastEventAt: null,
    })
  })

  it('conta sinais dentro da janela (24h) e ignora os de fora e de outras sessões', async () => {
    const s = await session()
    const other = await session()
    for (const st of ['sent', 'delivered', 'read'] as const) await msg(s.id, st, ago(H))
    await msg(s.id, 'queued', ago(H))
    await msg(s.id, 'failed', ago(2 * H))
    await msg(s.id, 'read', ago(2 * H), 'inbound')
    await msg(s.id, 'sent', ago(25 * H))
    await msg(other.id, 'failed', ago(H))
    await ev(s.id, 'disconnected', ago(3 * H))
    await ev(s.id, 'forbidden_403', ago(30 * H))
    await ev(s.id, 'connected', ago(10 * 60 * 1000))
    const h = await service().getHealth(s.id)
    expect(h).toMatchObject({ sent: 3, received: 1, failed: 1, disconnects: 1, forbidden403: 0 })
    expect(h.lastEventAt).toBe(ago(10 * 60 * 1000).toISOString())
  })

  it('tendência de erros: falhas de envio da metade recente menos a anterior (quedas não entram)', async () => {
    const s = await session()
    await msg(s.id, 'failed', ago(20 * H))
    for (let i = 0; i < 4; i++) await msg(s.id, 'failed', ago(H))
    await ev(s.id, 'disconnected', ago(2 * H))
    const st = await service().stats(s.id)
    expect(st).toMatchObject({ recentErrors: 4, previousErrors: 1, errorTrend: 3 })
  })

  it('quedas isoladas não pesam no score; só a 3ª em diante dentro de 60 min', async () => {
    const s = await session()
    for (const h of [1, 4, 7, 10, 13]) await ev(s.id, 'disconnected', ago(h * H)) // 5 quedas espaçadas
    let h = await service().getHealth(s.id)
    expect(h).toMatchObject({ disconnects: 5, score: 100, label: 'Good' })

    for (const min of [10, 20, 30, 40]) await ev(s.id, 'disconnected', ago(15 * H + min * 60_000)) // rajada de 4 em 30 min
    const st = await service().stats(s.id)
    expect(st).toMatchObject({ disconnects: 9, burstDisconnects: 2 })
    h = await service().getHealth(s.id)
    expect(h.score).toBe(90)
  })

  it('sinais até o último resume manual não contam', async () => {
    const s = await session()
    await ev(s.id, 'forbidden_403', ago(2 * H))
    await ev(s.id, 'resumed', ago(H))
    await ev(s.id, 'disconnected', ago(H / 2))
    const h = await service().getHealth(s.id)
    expect(h).toMatchObject({ forbidden403: 0, disconnects: 1 })
  })

  it('sessão inexistente → SESSION_NOT_FOUND', async () => {
    await expect(service().getHealth('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})
