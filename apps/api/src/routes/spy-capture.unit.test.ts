import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb, createTempDatabase, sessions, spyAds, spyProbes, type Database, type TempDatabase } from '@wsm/db'
import { SpyFinder, SpyHttp, SpyRunner, SpyStore } from '@wsm/core'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'
import { startAutomaticSpyProbe } from '../spy-auto'

let temp: TempDatabase, db: Database
beforeAll(async () => { temp = await createTempDatabase({ migrate: true, prefix: 'wsm_capture_api' }); db = createDb(temp.url) })
afterAll(async () => { await db?.$client.end(); await temp?.drop() })
const H = { authorization: 'Bearer capture-test', 'content-type': 'application/json' }

describe('capture-only HTTP API', () => {
  it('queues/polls/deduplicates with no automatic send, then accepts the explicit chip start', async () => {
    const redis = fakeRedis(), logger = captureLogger().logger
    const app = createApp({ db, redis, logger, apiToken: 'capture-test' })
    const [unused, chosen] = await db.insert(sessions).values([{ name: 'Unused', status: 'STABLE' }, { name: 'Chosen', status: 'STABLE' }]).returning()
    expect((await app.request('/api/spy/captures', { method: 'POST', body: '{}' })).status).toBe(401)
    const url = 'https://api.whatsapp.com/send?phone=5511999900044&token=SANITIZED_TOKEN&utm_source=fixture'
    const submit = () => app.request('/api/spy/captures', { method: 'POST', headers: H, body: JSON.stringify({ url }) })
    const created = await submit(), body = await created.json() as { capture_id: string }
    expect(created.status).toBe(201)
    const repeated = await submit()
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({ capture_id: body.capture_id, created: false, capture_only: true, offer_id: null })
    const callback = vi.fn((offerId: string) => startAutomaticSpyProbe({ db, redis, logger, offerId }).then(() => undefined))
    const fetch = vi.fn(async () => { throw new Error('No network expected for a direct WhatsApp link') })
    const runner = new SpyRunner({ store: new SpyStore(db), finder: new SpyFinder(new SpyHttp({ fetch })), onOfferFound: callback })
    await runner.tick()
    const progress = await app.request('/api/spy/captures/' + body.capture_id, { headers: H })
    const ready = await progress.json() as { offer_id: string }
    expect(ready).toMatchObject({ status: 'achado', finished: true, capture_only: true })
    expect(ready.offer_id).toBeTruthy()
    expect(callback).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(await db.select().from(spyProbes)).toHaveLength(0)
    expect(JSON.stringify(await db.select().from(spyAds))).not.toContain('SANITIZED_TOKEN')
    expect((await app.request(`/api/spy/offers/${ready.offer_id}/probes`, { method: 'POST', headers: H, body: '{}' })).status).toBe(400)
    const started = await app.request(`/api/spy/offers/${ready.offer_id}/probes`, { method: 'POST', headers: H, body: JSON.stringify({ sessionId: chosen!.id }) })
    expect(started.status).toBe(201)
    expect(await started.json()).toMatchObject({ sessionId: chosen!.id, offerId: ready.offer_id })
    expect((await db.select().from(spyProbes))[0]!.sessionId).not.toBe(unused!.id)
  })

  it('rejects bad links and extra start/automatic fields without creating capture jobs', async () => {
    const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: 'capture-test' })
    const before = await db.select().from(spyAds)
    for (const body of [{ url: 'https://evil.test/?u=https://wa.me/5511999900011' }, { url: 'https://wa.me/123' },
      { url: 'https://wa.me/5511999900011', autoProbe: true }, { url: 'https://wa.me/5511999900011', sessionId: 'chip' }]) {
      expect((await app.request('/api/spy/captures', { method: 'POST', headers: H, body: JSON.stringify(body) })).status).toBe(400)
    }
    expect(await db.select().from(spyAds)).toEqual(before)
    expect((await app.request('/api/spy/captures/00000000-0000-4000-8000-000000000001', { headers: H })).status).toBe(404)
  })
})
