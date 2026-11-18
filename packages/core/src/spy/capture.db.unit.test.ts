import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb, createTempDatabase, spyAds, spyOffers, spyProbes, type Database, type TempDatabase } from '@wsm/db'
import { SpyCaptureStore } from './capture'
import { SpyCaptureError } from './capture-url'
import { SpyStore } from './store'
import { SpyRunner } from './runner'
import { SpyFinder } from './finder'
import { SpyHttp } from './http'

let temp: TempDatabase, db: Database
beforeAll(async () => { temp = await createTempDatabase({ migrate: true, prefix: 'wsm_capture' }); db = createDb(temp.url, { max: 4 }) })
afterAll(async () => { await db?.$client.end(); await temp?.drop() })
beforeEach(async () => { await db.delete(spyProbes); await db.delete(spyAds); await db.delete(spyOffers) })
const wa = 'https://wa.me/5511999900011'
const ad = (id: string, phone: string) => `{"ad_archive_id":"${id}","page_name":"Fixture","cta_type":"WHATSAPP_MESSAGE","page_profile_uri":"https://www.facebook.com/fixture/","link_url":"https://wa.me/${phone}"}`
function runner() {
  const fetch = vi.fn(async () => new Response(ad('1234', '5511999900011')))
  const onOfferFound = vi.fn(async (_id: string) => undefined)
  const store = new SpyStore(db)
  const finder = new SpyFinder(new SpyHttp({ fetch, minIntervalMs: 0, sleep: async () => undefined }))
  return { store, fetch, onOfferFound, run: new SpyRunner({ store, finder, onOfferFound }) }
}

describe('manual capture durable intents', () => {
  it('concurrent equivalent links reuse one intent and eventually the same offer without automatic probe', async () => {
    const captures = new SpyCaptureStore(db), r = runner()
    const results = await Promise.all([captures.register(wa + '?token=SANITIZED_TOKEN', 'mcp'), captures.register('https://api.whatsapp.com/send?phone=5511999900011&fbclid=TRACK', 'mcp')])
    expect(results.map(x => x.created).sort()).toEqual([false, true])
    expect(results[0]!.row.id).toBe(results[1]!.row.id)
    const initial = await captures.get(results[0]!.row.id)
    expect(initial).toMatchObject({ status: 'na_fila', offer_id: null, capture_only: true, manual_start_required: true, finished: false })
    await r.run.tick()
    const ready = await captures.get(initial.capture_id)
    expect(ready).toMatchObject({ status: 'achado', finished: true })
    expect(ready.offer_id).toBeTruthy()
    expect((await captures.register(wa, 'mcp')).row.offerId).toBe(ready.offer_id)
    expect(await db.select().from(spyAds)).toHaveLength(1)
    expect(await db.select().from(spyOffers)).toHaveLength(1)
    expect(await db.select().from(spyProbes)).toEqual([])
    expect(r.onOfferFound).not.toHaveBeenCalled()
    expect(r.fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(await db.select().from(spyAds))).not.toContain('SANITIZED_TOKEN')
    expect(JSON.stringify(ready)).not.toContain('inputUrl')
  })

  it('preserves capture-only through ad metadata, restart/stale recovery and retry', async () => {
    const captures = new SpyCaptureStore(db), r = runner()
    const result = await captures.register('https://facebook.com/ads/library/?id=1234&token=SANITIZED_TOKEN', 'mcp')
    const claimed = await r.store.claimNext()
    expect(claimed?.id).toBe(result.row.id)
    await db.update(spyAds).set({ updatedAt: new Date(0) }).where(eq(spyAds.id, result.row.id))
    expect(await r.store.requeueStale()).toBe(1)
    const restarted = runner()
    await restarted.run.tick()
    expect(restarted.onOfferFound).not.toHaveBeenCalled()
    const ready = await captures.get(result.row.id)
    expect(ready.offer_id).toBeTruthy()
    expect((await db.select().from(spyAds))[0]!.data.captureOnly).toBe(true)
    await r.store.failed(result.row.id, 'fixture failure')
    await r.store.retry(result.row.id)
    await r.run.tick()
    expect(r.onOfferFound).not.toHaveBeenCalled()
    expect(await db.select().from(spyProbes)).toEqual([])
    expect((await captures.get(result.row.id)).offer_id).toBe(ready.offer_id)
  })

  it('search expansion keeps manual mode, reuses captured children and never chooses the first of two offers', async () => {
    const captures = new SpyCaptureStore(db), r = runner()
    const existing = await captures.register('https://facebook.com/ads/library/?id=1234', 'mcp')
    const search = await captures.register('https://facebook.com/ads/library/?q=soap&token=SANITIZED_TOKEN', 'mcp')
    const parent = search.row
    await r.store.expand(parent, [
      { adArchiveId: '1234', profileUri: 'https://www.facebook.com/fixture/', linkUrl: wa, images: [], videos: [] },
      { adArchiveId: '5678', profileUri: 'https://www.facebook.com/fixture/', linkUrl: 'https://wa.me/5511999900022', images: [], videos: [] },
    ])
    const expanded = await captures.get(parent.id)
    expect(expanded.children.map(c => c.capture_id)).toContain(existing.row.id)
    expect(expanded.finished).toBe(false)
    await r.run.tick(); await r.run.tick()
    const ready = await captures.get(parent.id)
    expect(ready.offer_id).toBeNull()
    expect(ready.offer_ids).toHaveLength(2)
    expect(ready.requires_offer_choice).toBe(true)
    expect(ready.finished).toBe(true)
    expect(r.onOfferFound).not.toHaveBeenCalled()
  })

  it('does not adopt legacy automatic rows and preserves the original panel callback', async () => {
    const captures = new SpyCaptureStore(db), r = runner()
    const legacy = await r.store.enqueue([wa], 'panel')
    await expect(captures.register(wa, 'mcp')).rejects.toMatchObject({ code: 'LEGACY_CAPTURE' })
    await expect(captures.get(legacy.created[0]!.id)).rejects.toBeInstanceOf(SpyCaptureError)
    await r.run.tick()
    expect(r.onOfferFound).toHaveBeenCalledOnce()
    expect(await db.select().from(spyAds)).toHaveLength(1)
  })

  it('returns safe failure/progress states and rejects absent IDs', async () => {
    const captures = new SpyCaptureStore(db), r = runner(), result = await captures.register(wa, 'mcp')
    await r.store.failed(result.row.id, 'SANITIZED_TOKEN private failure')
    expect(await captures.get(result.row.id)).toMatchObject({ status: 'erro', finished: true, reason: 'capture_failed' })
    expect(JSON.stringify(await captures.get(result.row.id))).not.toContain('SANITIZED_TOKEN')
    await r.store.retryLater(result.row.id, 'private reason', new Date(Date.now() + 60000))
    expect(await captures.get(result.row.id)).toMatchObject({ status: 'na_fila', finished: false, reason: 'retry_scheduled' })
    await expect(captures.get('00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
