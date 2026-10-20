// Rotas do Espião com Postgres local: fila de links, número manual, tentar de novo e remover.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, messages, sessions, spyOffers, type Database, type TempDatabase } from '@wsm/db'
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

  it('sondas: começa numa oferta com um chip, recusa a segunda e chip desconectado, lista, mostra a conversa e para', async () => {
    const [offer] = await db.insert(spyOffers).values({ phone: '5588933009387', pageName: 'Chef Maria' }).returning()
    const [chip] = await db.insert(sessions).values({ name: 'chip1', phone: '+5531900000001', status: 'STABLE' }).returning()
    const [down] = await db.insert(sessions).values({ name: 'chip2', phone: '+5531900000002', status: 'DISCONNECTED' }).returning()
    const start = (sessionId: string) => app.request(`/api/spy/offers/${offer!.id}/probes`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId }) })

    const notReady = await start(down!.id)
    expect(notReady.status).toBe(409)
    expect(((await notReady.json()) as { error: { code: string } }).error.code).toBe('SESSION_NOT_CONNECTED')

    const res = await start(chip!.id)
    expect(res.status).toBe(201)
    const probe = await res.json() as { id: string; status: string }
    expect(probe.status).toBe('ativa')
    expect((await start(chip!.id)).status).toBe(409)

    await db.insert(messages).values({ sessionId: chip!.id, phone: '+5588933009387', direction: 'inbound', status: 'delivered', content: { type: 'conversation', text: 'Olá!' } })
    const list = await (await app.request('/api/spy/probes', { headers: auth })).json() as { items: Array<{ id: string; sessionName: string; pageName: string }> }
    expect(list.items[0]).toMatchObject({ id: probe.id, sessionName: 'chip1', pageName: 'Chef Maria' })
    const conv = await (await app.request(`/api/spy/probes/${probe.id}/messages`, { headers: auth })).json() as { items: Array<{ de: string; texto: string }> }
    expect(conv.items).toEqual([expect.objectContaining({ de: 'oferta', texto: 'Olá!' })])

    const stop = await app.request(`/api/spy/probes/${probe.id}/stop`, { method: 'POST', headers: auth })
    expect(stop.status).toBe(200)
    expect(await stop.json()).toMatchObject({ status: 'parada', listenUntil: null })
    expect((await app.request(`/api/spy/probes/${probe.id}/stop`, { method: 'POST', headers: auth })).status).toBe(404)
  })
})
