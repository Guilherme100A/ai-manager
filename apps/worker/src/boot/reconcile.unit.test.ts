// Reconciliação de `processing` no boot (AC-T16-05) com Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb, createTempDatabase, messageEvents, messages, sessions, type Database, type TempDatabase } from '@wsm/db'
import { reconcileProcessing, UNKNOWN_DELIVERY_ERROR } from './reconcile'
import { memoryInflightStore } from './send-guard'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_worker_reconcile' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

beforeEach(async () => {
  await db.delete(sessions)
})

async function session() {
  const [row] = await db.insert(sessions).values({ name: 's', phone: '+5511999990001', status: 'STABLE' }).returning()
  return row!.id
}

async function message(sessionId: string, status: 'processing' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed', transportMessageId: string | null = null) {
  const [row] = await db
    .insert(messages)
    .values({ sessionId, phone: '+5511988887777', content: { text: 'x' }, status, transportMessageId, attempts: 1 })
    .returning()
  return row!.id
}

const statusOf = async (id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0]!

describe('reconcileProcessing', () => {
  it('two-chip rollout: terminal ACKs and failed media are never requeued on startup', async () => {
    const a = await session(), b = await session()
    const ids = [await message(a, 'delivered', 'WA-A'), await message(b, 'read', 'WA-B'), await message(a, 'failed')]
    const before = await Promise.all(ids.map(statusOf)), requeued: string[] = []
    const result = await reconcileProcessing({ db, inflight: memoryInflightStore(), requeue: async (_sid, id) => void requeued.push(id) })
    expect(result).toEqual({ sent: [], retrying: [], failed: [] })
    expect(requeued).toEqual([])
    expect(await Promise.all(ids.map(statusOf))).toEqual(before)
  })
  it('com transport_message_id → sent; sem marca → retrying e requeue; com marca → failed sem requeue', async () => {
    const s1 = await session()
    const s2 = await session()
    const s3 = await session()
    const withTid = await message(s1, 'processing', 'WA-1')
    const noMark = await message(s2, 'processing')
    const marked = await message(s3, 'processing')
    const untouched = await message(s1, 'queued')
    const inflight = memoryInflightStore()
    await inflight.mark(s3)
    const requeued: string[] = []
    const statuses: string[] = []

    const res = await reconcileProcessing({
      db,
      inflight,
      requeue: async (sid, mid) => void requeued.push(`${sid}/${mid}`),
      onStatus: (ev) => void statuses.push(`${ev.messageId}:${ev.to}`),
    })

    expect(res).toEqual({ sent: [withTid], retrying: [noMark], failed: [marked] })
    expect((await statusOf(withTid)).status).toBe('sent')
    expect((await statusOf(withTid)).sentAt).not.toBeNull()
    expect((await statusOf(noMark)).status).toBe('retrying')
    expect((await statusOf(marked)).status).toBe('failed')
    expect((await statusOf(marked)).error).toBe(UNKNOWN_DELIVERY_ERROR)
    expect((await statusOf(untouched)).status).toBe('queued')
    expect(requeued).toEqual([`${s2}/${noMark}`])
    expect(statuses.sort()).toEqual([`${marked}:failed`, `${noMark}:retrying`, `${withTid}:sent`].sort())
    // toda transição grava message_event marcada como reconciliada
    const ev = await db.select().from(messageEvents).where(eq(messageEvents.messageId, marked))
    expect(ev.at(-1)).toMatchObject({ fromStatus: 'processing', toStatus: 'failed', detail: { reconciled: true } })
    // marcas limpas depois da reconciliação
    expect(inflight.keys.size).toBe(0)
  })

  it('sem nada preso: no-op, e limpa marcas órfãs', async () => {
    const s = await session()
    await message(s, 'sent', 'WA-9')
    const inflight = memoryInflightStore()
    await inflight.mark(s)
    const res = await reconcileProcessing({ db, inflight, requeue: async () => {} })
    expect(res).toEqual({ sent: [], retrying: [], failed: [] })
    expect(inflight.keys.size).toBe(0)
  })
})
