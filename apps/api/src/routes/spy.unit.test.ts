// Rotas do Espião com Postgres local: fila de links, número manual, tentar de novo e remover.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { AiSettingsService } from '@wsm/core'
import { createDb, createTempDatabase, messages, sessions, spyMedia, spyOffers, spyProbes, type Database, type TempDatabase } from '@wsm/db'
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

  it('baixa o fluxo em ZIP com resumo, conversa (transcrições) e as imagens/PDF', async () => {
    const [offer] = await db.insert(spyOffers).values({ phone: '557991063916', pageName: 'Receitas Que Nutrem', status: 'completa' }).returning()
    const [chip] = await db.insert(sessions).values({ name: 'chipZ', phone: '+5531900000009', status: 'STABLE' }).returning()
    const [probe] = await db.insert(spyProbes).values({ offerId: offer!.id, sessionId: chip!.id, phone: '+557991063916', branch: 'principal', status: 'concluida', createdBy: 'a', summary: { preco: 'R$ 47', checkout: ['https://pay.x/abc'] } }).returning()
    const [audio] = await db.insert(messages).values({ sessionId: chip!.id, phone: '+557991063916', direction: 'inbound', status: 'delivered', content: { type: 'audioMessage', transcript: 'é só pagar 47 no pix' } }).returning()
    await db.insert(spyMedia).values({ offerId: offer!.id, probeId: probe!.id, messageId: audio!.id, branch: 'principal', kind: 'image', mime: 'image/jpeg', fileName: 'card.jpg', bytes: Buffer.from('fake-jpeg'), size: 9 })
    await db.insert(spyMedia).values({ offerId: offer!.id, probeId: probe!.id, branch: 'principal', kind: 'audio', mime: 'audio/ogg; codecs=opus', bytes: Buffer.from('fake-ogg'), size: 8 })

    const res = await app.request(`/api/spy/offers/${offer!.id}/flow.zip`, { headers: { authorization: 'Bearer spy-test' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    const zip = await JSZip.loadAsync(await res.arrayBuffer())
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['resumo.md', 'roteiro.txt', 'conversa-principal.md']))
    expect(await zip.file('resumo.md')!.async('string')).toContain('R$ 47')
    expect(await zip.file('conversa-principal.md')!.async('string')).toContain('[áudio] é só pagar 47 no pix')
    const mediaPaths = Object.keys(zip.files).filter((p) => p.startsWith('midias/') && !zip.files[p]!.dir)
    const imgPath = mediaPaths.find((p) => p.endsWith('card.jpg'))
    expect(imgPath).toBeTruthy()
    expect(await zip.file(imgPath!)!.async('string')).toBe('fake-jpeg')
    const audioPath = mediaPaths.find((p) => p.endsWith('.ogg'))
    expect(audioPath).toBeTruthy()
    expect(await zip.file(audioPath!)!.async('string')).toBe('fake-ogg')

    expect((await app.request('/api/spy/offers/00000000-0000-0000-0000-000000000000/flow.zip', { headers: { authorization: 'Bearer spy-test' } })).status).toBe(404)
  })

  it('copia o fluxo pra IA do CRM (vira contexto do negócio)', async () => {
    const [offer] = await db.insert(spyOffers).values({ phone: '558781794012', pageName: 'Delícias da Mih', status: 'completa' }).returning()
    const [chip] = await db.insert(sessions).values({ name: 'chipC', phone: '+5531900000010', status: 'STABLE' }).returning()
    await db.insert(spyProbes).values({ offerId: offer!.id, sessionId: chip!.id, phone: '+558781794012', branch: 'principal', status: 'concluida', createdBy: 'a', summary: { preco: 'R$ 37', checkout: ['https://pay.x/mih'] } }).returning()

    const res = await app.request(`/api/spy/offers/${offer!.id}/copy-to-crm`, { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })

    const settings = await new AiSettingsService({ db, env: {} }).resolve()
    expect(settings.config.businessContext).toContain('R$ 37')

    expect((await app.request('/api/spy/offers/00000000-0000-0000-0000-000000000000/copy-to-crm', { method: 'POST', headers: auth })).status).toBe(404)
  })
})
