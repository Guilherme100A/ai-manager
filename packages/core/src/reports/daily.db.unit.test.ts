// Relatório diário com Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { auditLogs, createDb, createTempDatabase, healthEvents, messages, proxies, sessions, type Database, type TempDatabase } from '@wsm/db'
import { generateCredentialsKey, resetCredentialsCrypto } from '../crypto'
import { ProxyService } from '../proxy/service'
import { buildDailyReport } from './daily'

let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_report' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

beforeEach(async () => {
  await db.delete(auditLogs)
  await db.delete(sessions)
  await db.delete(proxies)
})

// 07/10 15:00 em Brasília.
const NOW = new Date('2026-10-07T18:00:00Z')
const at = (iso: string) => new Date(iso)

async function chip(name: string, proxyId?: string) {
  const [s] = await db.insert(sessions).values({ name, phone: `+55319${Math.floor(1e7 + Math.random() * 8e7)}`, status: 'WARMING',
    warmupStartedAt: at('2026-10-05T19:00:00Z'), ...(proxyId ? { proxyId } : {}) }).returning()
  return s!
}
const msg = (sessionId: string, status: 'delivered' | 'failed' | 'queued', createdAt: Date, direction: 'outbound' | 'inbound' = 'outbound') =>
  db.insert(messages).values({ sessionId, phone: '+5531900000000', content: { text: 'x' }, status, direction, createdAt })
const ev = (sessionId: string, type: string, createdAt: Date, detail: Record<string, unknown> | null = null) =>
  db.insert(healthEvents).values({ sessionId, type, detail, createdAt })
const audit = (action: string, targetId: string, detail: Record<string, unknown>, createdAt: Date) =>
  db.insert(auditLogs).values({ actor: 'group-automation', action, targetType: 'session', targetId, detail, createdAt })

describe('relatório diário', () => {
  it('agrupa por chip e por dia de Brasília: envios, quedas por código, proxy, DEGRADED, bloqueio e grupos', async () => {
    const proxy = await new ProxyService(db).create({ url: 'http://u:p@10.0.0.1:3128' })
    const a = await chip('chip A', proxy.id)
    const b = await chip('chip B')

    await msg(a.id, 'delivered', at('2026-10-07T12:00:00Z'))
    await msg(a.id, 'delivered', at('2026-10-07T12:01:00Z'))
    await msg(a.id, 'failed', at('2026-10-07T12:02:00Z'))
    await msg(a.id, 'queued', at('2026-10-07T12:03:00Z'))
    await msg(a.id, 'delivered', at('2026-10-07T12:04:00Z'), 'inbound')
    // 02:30Z do dia 07 ainda é dia 06 em Brasília (23:30).
    await msg(a.id, 'delivered', at('2026-10-07T02:30:00Z'))

    await ev(a.id, 'disconnected', at('2026-10-07T13:00:00Z'), { reason: 'transient', statusCode: 428 })
    await ev(a.id, 'disconnected', at('2026-10-07T14:00:00Z'), { reason: 'transient', statusCode: 428 })
    await ev(a.id, 'disconnected', at('2026-10-07T15:00:00Z'), { reason: 'transient', statusCode: 503 })
    await ev(a.id, 'proxy_unavailable', at('2026-10-07T15:00:01Z'), { message: 'timeout' })
    await ev(a.id, 'health_degraded', at('2026-10-07T15:00:02Z'), { score: 60 })
    await ev(a.id, 'connected', at('2026-10-07T15:00:03Z'))
    await ev(b.id, 'disconnected', at('2026-10-07T16:00:00Z'), { reason: 'loggedOut', statusCode: 401 })
    await ev(b.id, 'forbidden_403', at('2026-10-07T16:00:01Z'), { statusCode: 403 })

    await audit('group.automation', a.id, { action: 'group_rejected', reason: 'filtered' }, at('2026-10-07T12:00:00Z'))
    await audit('group.automation', a.id, { action: 'group_discovered' }, at('2026-10-07T12:10:00Z'))
    await audit('group.invite.flow', b.id, { result: 'awaiting_confirmation', targetSessionId: a.id }, at('2026-10-07T12:20:00Z'))
    await audit('group.invite.flow', b.id, { result: 'started', targetSessionId: a.id }, at('2026-10-07T12:19:00Z'))
    await audit('group.automation', a.id, { action: 'join_result', state: 'joined' }, at('2026-10-07T12:30:00Z'))

    const r = await buildDailyReport(db, { days: 3, now: () => NOW })
    expect(r.days).toEqual(['2026-10-07', '2026-10-06', '2026-10-05'])
    expect(r.chips.map((c) => [c.name, c.proxy, c.status])).toEqual([['chip A', true, 'WARMING'], ['chip B', false, 'WARMING']])
    expect(r.chips[0]).toMatchObject({ warmupDay: 1, dailyLimit: 36 })

    const today = (id: string) => r.rows.find((x) => x.day === '2026-10-07' && x.sessionId === id)
    expect(today(a.id)).toMatchObject({
      sent: 2, failed: 1, received: 1, disconnects: 3, disconnectCodes: { 428: 2, 503: 1 }, proxyUnavailable: 1, degraded: 1, blocked: 0,
      groupsJoined: 1, groupsPending: 1, groupsRejected: 1, groupsDiscovered: 1,
    })
    expect(today(b.id)).toMatchObject({ disconnects: 1, blocked: 2, groupsPending: 0 })
    expect(r.rows.find((x) => x.day === '2026-10-06' && x.sessionId === a.id)).toMatchObject({ sent: 1 })
    expect(r.rows[0]!.day).toBe('2026-10-07')
  })

  it('travamentos do worker: por dia, últimos e quedas ligadas a eles (até 60 s depois)', async () => {
    const a = await chip('chip A')
    const stall = (createdAt: Date, lagMs: number) =>
      db.insert(auditLogs).values({ actor: 'worker', action: 'worker.stall', targetType: 'worker', detail: { lagMs, heapMb: 120, activity: { 'msg:chip:grupo': 3 } }, createdAt })
    await stall(at('2026-10-07T13:00:00Z'), 1500)
    await stall(at('2026-10-07T16:00:00Z'), 4200)
    await ev(a.id, 'disconnected', at('2026-10-07T13:00:30Z'), { reason: 'transient', statusCode: 428 }) // 30 s depois: ligada
    await ev(a.id, 'disconnected', at('2026-10-07T14:00:00Z'), { reason: 'transient', statusCode: 428 }) // sem travamento
    await ev(a.id, 'disconnected', at('2026-10-07T15:59:00Z'), { reason: 'transient', statusCode: 428 }) // antes do travamento

    const r = await buildDailyReport(db, { days: 2, now: () => NOW })
    expect(r.worker).toEqual([{ day: '2026-10-07', stalls: 2, maxLagMs: 4200 }])
    expect(r.recentStalls.map((s) => [s.at, s.lagMs, s.heapMb])).toEqual([
      ['2026-10-07T16:00:00.000Z', 4200, 120],
      ['2026-10-07T13:00:00.000Z', 1500, 120],
    ])
    expect(r.recentStalls[0]!.activity).toEqual({ 'msg:chip:grupo': 3 })
    expect(r.rows.find((x) => x.sessionId === a.id)).toMatchObject({ disconnects: 3, disconnectsNearStall: 1 })
  })

  it('dias fora do período e chips removidos não aparecem', async () => {
    const a = await chip('chip A')
    await msg(a.id, 'delivered', at('2026-09-20T12:00:00Z'))
    const r = await buildDailyReport(db, { days: 1, now: () => NOW })
    expect(r.days).toEqual(['2026-10-07'])
    expect(r.rows).toEqual([])
    expect(r.chips).toHaveLength(1)
  })
})
