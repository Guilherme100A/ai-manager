// Rotas do Espião com Postgres local: fila de links, número manual, tentar de novo e remover.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

let tmp: TempDatabase
let db: Database
let app: ReturnType<typeof createApp>
const auth = { authorization: 'Bearer spy-test', 'content-type': 'application/json' }

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_spy_api' })
  db = createDb(tmp.url)
  app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: 'spy-test' })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

describe('/api/spy', () => {
  it('exige login', async () => {
    expect((await app.request('/api/spy/ads')).status).toBe(401)
  })

  it('enfileira links, aceita número manual, agrupa na oferta, tenta de novo e remove', async () => {
    const res = await app.request('/api/spy/ads', { method: 'POST', headers: auth, body: JSON.stringify({ links: ['https://www.facebook.com/ads/library/?id=123', 'https://exemplo.com', 'https://www.facebook.com/ads/library/?id=123'] }) })
    expect(res.status).toBe(201)
    const body = await res.json() as { created: Array<{ id: string; status: string }>; skipped: Array<{ reason: string }> }
    expect(body.created).toHaveLength(1)
    expect(body.created[0]!.status).toBe('na_fila')
    expect(body.skipped).toHaveLength(1)
    const id = body.created[0]!.id

    expect((await app.request('/api/spy/ads', { method: 'POST', headers: auth, body: JSON.stringify({ links: [] }) })).status).toBe(400)
    expect((await app.request(`/api/spy/ads/${id}/phone`, { method: 'PUT', headers: auth, body: JSON.stringify({ phone: '123' }) })).status).toBe(400)

    const manual = await app.request(`/api/spy/ads/${id}/phone`, { method: 'PUT', headers: auth, body: JSON.stringify({ phone: '+55 84 92002-2034' }) })
    expect(manual.status).toBe(200)
    expect(await manual.json()).toMatchObject({ status: 'achado', phone: '5584920022034', foundVia: 'manual' })

    const offers = await (await app.request('/api/spy/offers', { headers: auth })).json() as { items: Array<{ phone: string; ads: number }> }
    expect(offers.items).toEqual([expect.objectContaining({ phone: '5584920022034', ads: 1 })])

    // "achado" não volta para a fila
    expect((await app.request(`/api/spy/ads/${id}/retry`, { method: 'POST', headers: auth })).status).toBe(404)
    expect((await app.request(`/api/spy/ads/${id}`, { method: 'DELETE', headers: auth })).status).toBe(204)
    expect((await app.request(`/api/spy/ads/${id}`, { method: 'DELETE', headers: auth })).status).toBe(404)
  })
})
