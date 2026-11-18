import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb, createTempDatabase, messages, sessions, spyProbes, type Database, type TempDatabase } from '@wsm/db'
import { MessageStore, SendPipeline, SpyCaptureStore, SpyFinder, SpyHttp, SpyProbeStore, SpyRunner, SpyStore, toMessageView, toSessionView } from '@wsm/core'
import { SpyProbeRunner } from './probes'

let temp: TempDatabase, db: Database
beforeAll(async () => { temp = await createTempDatabase({ migrate: true, prefix: 'wsm_capture_probe' }); db = createDb(temp.url) })
afterAll(async () => { await db?.$client.end(); await temp?.drop() })

describe('capture through explicit probe with fake transport', () => {
  it('keeps discovery silent and only the selected chip sends after explicit start; stop preserves the accepted message', async () => {
    const [first, selected] = await db.insert(sessions).values([{ name: 'First', status: 'STABLE' }, { name: 'Selected', status: 'STABLE' }]).returning()
    const captures = new SpyCaptureStore(db), probes = new SpyProbeStore(db), messageStore = new MessageStore(db)
    const transport = { send: vi.fn(async (_sessionId: string) => undefined) }
    const capture = await captures.register('https://wa.me/5511999900033?token=SANITIZED_TOKEN', 'mcp')
    const automatic = vi.fn(async (offerId: string) => { await probes.create({ offerId, sessionId: first!.id, createdBy: 'automatic' }) })
    const finder = new SpyFinder(new SpyHttp({ fetch: async () => { throw Error('No HTTP expected') } }))
    await new SpyRunner({ store: new SpyStore(db), finder, onOfferFound: automatic }).tick()
    const ready = await captures.get(capture.row.id)
    expect(automatic).not.toHaveBeenCalled()
    expect(await db.select().from(spyProbes)).toEqual([])
    expect(await db.select().from(messages)).toEqual([])
    expect(transport.send).not.toHaveBeenCalled()
    const probe = await probes.create({ offerId: ready.offer_id!, sessionId: selected!.id, createdBy: 'explicit' })
    const pipeline = new SendPipeline({ db, queue: { enqueue: async input => {
      const row = await messageStore.create(input)
      await messageStore.transition(row.id, 'processing')
      await transport.send(input.sessionId)
      const sent = await messageStore.transition(row.id, 'sent', { set: { sentAt: new Date(), transportMessageId: 'fake-wa' } })
      return toMessageView(sent.row)
    } } })
    const runner = new SpyProbeRunner({ store: probes, pipeline,
      model: { decide: async () => { throw Error('An opening does not need AI') } },
      manager: { get: async id => toSessionView((await db.select().from(sessions).where(eq(sessions.id, id)))[0]!), getTransport: () => undefined },
      messages: { get: async id => toMessageView(await messageStore.get(id)) }, allowed: async () => true,
      offerContext: async () => ({}), sleep: async () => undefined, random: () => 0,
      logger: { info() {}, warn() {} },
    })
    await runner.tick()
    expect(transport.send).toHaveBeenCalledExactlyOnceWith(selected!.id)
    expect((await db.select().from(messages))[0]).toMatchObject({ sessionId: selected!.id, origin: 'spy', status: 'sent' })
    await probes.end(probe.id, 'parada', 'explicit stop')
    await runner.tick()
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect((await probes.get(probe.id))?.status).toBe('parada')
  })
})
