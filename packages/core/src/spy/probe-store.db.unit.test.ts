// Sondas com Postgres local: travas da criação, histórico da conversa e janela do remarketing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { auditLogs, contacts, createDb, createTempDatabase, messages, sessions, spyOffers, spyProbes, type Database, type TempDatabase } from '@wsm/db'
import { parseDecision, ProbeAiDisabledError, SpyProbeModel } from './probe-model'
import { contentText, SPY_CONSENT_SOURCE, SpyProbeError, SpyProbeStore } from './probe-store'

let tmp: TempDatabase
let db: Database
let now = Date.parse('2026-10-20T12:00:00Z')

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_spy_probe' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

beforeEach(async () => {
  await db.delete(spyProbes)
  await db.delete(spyOffers)
  await db.delete(messages)
  await db.delete(contacts)
  await db.delete(sessions)
  now = Date.parse('2026-10-20T12:00:00Z')
})

async function fixture(status: 'STABLE' | 'DISCONNECTED' = 'STABLE') {
  const [session] = await db.insert(sessions).values({ name: 'chip1', phone: '+5531900000001', status }).returning()
  const [offer] = await db.insert(spyOffers).values({ phone: '5584920022034', pageName: 'Chef Maria' }).returning()
  return { session: session!, offer: offer!, store: new SpyProbeStore(db, () => now) }
}

describe('SpyProbeStore', () => {
  it('cria a sonda: contato com consentimento da origem "anúncio", oferta sondando, auditoria e abertura pendente', async () => {
    const { session, offer, store } = await fixture()
    const probe = await store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'admin' })
    expect(probe).toMatchObject({ status: 'ativa', phone: '+5584920022034', turns: 0, maxTurns: 12 })
    expect(probe.replyDueAt).toEqual(new Date(now))
    const [contact] = await db.select().from(contacts)
    expect(contact).toMatchObject({ phone: '+5584920022034', consent: true, consentSource: SPY_CONSENT_SOURCE, name: 'Chef Maria' })
    expect((await db.select().from(spyOffers))[0]!.status).toBe('sondando')
    expect((await db.select().from(auditLogs)).some((a) => a.action === 'spy.probe.start')).toBe(true)
    await expect(store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'admin' })).rejects.toMatchObject({ code: 'PROBE_ACTIVE' })
  })

  it('recusa chip desconectado, opt-out, número de chip próprio e mais de 5 sondas do chip em 24 h', async () => {
    const off = await fixture('DISCONNECTED')
    await expect(off.store.create({ offerId: off.offer.id, sessionId: off.session.id, createdBy: 'a' })).rejects.toMatchObject({ code: 'SESSION_NOT_READY' })
    await db.delete(spyOffers); await db.delete(sessions)

    const { session, offer, store } = await fixture()
    await db.insert(contacts).values({ phone: '+5584920022034', optOut: true })
    await expect(store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'a' })).rejects.toBeInstanceOf(SpyProbeError)
    await db.delete(contacts)

    const [own] = await db.insert(spyOffers).values({ phone: '5531900000001' }).returning()
    await expect(store.create({ offerId: own!.id, sessionId: session.id, createdBy: 'a' })).rejects.toMatchObject({ code: 'OWN_NUMBER' })

    for (let i = 0; i < 5; i++) {
      const [o] = await db.insert(spyOffers).values({ phone: `551199999000${i}` }).returning()
      await store.create({ offerId: o!.id, sessionId: session.id, createdBy: 'a' })
    }
    await expect(store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'a' })).rejects.toMatchObject({ code: 'DAILY_LIMIT' })
  })

  it('histórico com as duas pontas (áudio vira [áudio]), mensagem mais recente e janela do remarketing', async () => {
    const { session, offer, store } = await fixture()
    const probe = await store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'a' })
    const at = (s: number) => new Date(now + s * 1000)
    await db.insert(messages).values([
      { sessionId: session.id, phone: probe.phone, direction: 'outbound', status: 'sent', content: { text: 'Oi! Vi o anúncio' }, createdAt: at(1) },
      { sessionId: session.id, phone: probe.phone, direction: 'inbound', status: 'delivered', content: { type: 'conversation', text: 'Olá! Qual seu nome?' }, createdAt: at(2) },
      { sessionId: session.id, phone: probe.phone, direction: 'inbound', status: 'delivered', content: { type: 'audioMessage' }, createdAt: at(3) },
      { sessionId: session.id, phone: probe.phone, direction: 'outbound', status: 'failed', content: { text: 'não saiu' }, createdAt: at(4) },
      { sessionId: session.id, phone: '+5511000000000', direction: 'inbound', status: 'delivered', content: { type: 'conversation', text: 'outro' }, createdAt: at(5) },
    ])
    expect((await store.history(probe)).map(({ de, texto }) => [de, texto])).toEqual([['eu', 'Oi! Vi o anúncio'], ['oferta', 'Olá! Qual seu nome?'], ['oferta', '[áudio]']])
    expect(await store.latestInbound(probe)).toEqual(at(3))

    await store.inboundSeen(probe.id, at(3), 60_000)
    expect((await store.due()).length).toBe(0)
    now += 61_000
    expect((await store.due()).map((p) => p.id)).toEqual([probe.id])

    expect(await store.listening(session.id, probe.phone)).toBeTruthy()
    await store.end(probe.id, 'concluida', 'checkout capturado')
    expect((await store.get(probe.id))!.listenUntil).toEqual(new Date(now + 7 * 86_400_000))
    expect((await db.select().from(spyOffers))[0]!.status).toBe('completa')
    expect(await store.listening(session.id, probe.phone)).toBeTruthy() // ainda grava o remarketing
    now += 8 * 86_400_000
    expect(await store.listening(session.id, probe.phone)).toBeUndefined()
  })

  it('attachMedia grava o conteúdo lido e o histórico passa a mostrá-lo', async () => {
    const { session, offer, store } = await fixture()
    const probe = await store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'a' })
    const [audio] = await db.insert(messages).values(
      { sessionId: session.id, phone: probe.phone, direction: 'inbound', status: 'delivered', content: { type: 'audioMessage', pushName: 'Maria' }, createdAt: new Date(now + 2000) },
    ).returning()
    await store.attachMedia(audio!.id, { transcript: 'é só clicar no link e pagar 97' })
    // Merge preserva o que já havia no content.
    const [row] = await db.select().from(messages).where(eq(messages.id, audio!.id))
    expect(row!.content).toMatchObject({ type: 'audioMessage', pushName: 'Maria', transcript: 'é só clicar no link e pagar 97' })
    expect((await store.history(probe)).map((t) => t.texto)).toEqual(['[áudio] é só clicar no link e pagar 97'])
  })
})

describe('parseDecision e contentText', () => {
  it('aceita JSON com texto em volta, limita a 2 mensagens e trata lixo como "esperar"', () => {
    expect(parseDecision('Claro: {"acao":"responder","mensagens":["a","b","c"],"preco":"R$ 47","checkout":[],"opcoes":["1) Sim"],"humano":false}'))
      .toMatchObject({ acao: 'responder', mensagens: ['a', 'b'], preco: 'R$ 47', opcoes: ['1) Sim'] })
    expect(parseDecision('{"acao":"responder","mensagens":[]}')).toMatchObject({ acao: 'esperar' })
    expect(parseDecision('não sei')).toMatchObject({ acao: 'esperar', motivo: 'resposta da IA sem JSON válido' })
    expect(parseDecision('{"acao":"encerrar","mensagens":["tchau"],"checkout":["https://pay.x"]}')).toMatchObject({ acao: 'encerrar', mensagens: [], checkout: ['https://pay.x'] })
  })

  it('texto das linhas de messages', () => {
    expect(contentText({ type: 'imageMessage', text: 'olha' })).toBe('[imagem] olha')
    expect(contentText({ image: { url: 'x' }, caption: 'c' })).toBe('c')
    expect(contentText({ audio: { url: 'x' } })).toBe('[áudio]')
    expect(contentText(null)).toBe('[mensagem]')
  })

  it('áudio/vídeo transcrito, PDF e imagem lidos entram no texto (mídia do Espião)', () => {
    expect(contentText({ type: 'audioMessage', transcript: 'o curso custa 97 reais' })).toBe('[áudio] o curso custa 97 reais')
    expect(contentText({ type: 'videoMessage', transcript: 'nesse vídeo eu te explico o método' })).toBe('[vídeo] nesse vídeo eu te explico o método')
    expect(contentText({ type: 'documentMessage', docText: 'Plano Premium — R$ 497', fileName: 'oferta.pdf' })).toBe('[documento: oferta.pdf] Plano Premium — R$ 497')
    expect(contentText({ type: 'documentMessage', docText: 'texto do pdf' })).toBe('[documento] texto do pdf')
    expect(contentText({ type: 'imageMessage', imageText: 'OFERTA R$ 47 no pix' })).toBe('[imagem] OFERTA R$ 47 no pix')
    // Sem conteúdo lido, continua só o rótulo.
    expect(contentText({ type: 'audioMessage' })).toBe('[áudio]')
  })
})

describe('SpyProbeModel', () => {
  const settings = async () => ({ provider: 'anthropic', enabled: false, config: { apiKey: 'k', smallModel: 'm', largeModel: 'm', timeoutMs: 10_000 } }) as never
  it('usa a chave mesmo com a IA das conversas desligada; sem crédito/chave inválida vira ProbeAiDisabledError; 429 não', async () => {
    const ok = new SpyProbeModel(settings, () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: '{"acao":"responder","mensagens":["oi"]}' }] }) } }) as never)
    expect(await ok.decide([], { turnosRestantes: 5 })).toMatchObject({ acao: 'responder', mensagens: ['oi'] })
    const broke = new SpyProbeModel(settings, () => ({ messages: { create: async () => { throw Object.assign(new Error('Your credit balance is too low'), { status: 400 }) } } }) as never)
    await expect(broke.decide([], { turnosRestantes: 5 })).rejects.toBeInstanceOf(ProbeAiDisabledError)
    const busy = new SpyProbeModel(settings, () => ({ messages: { create: async () => { throw Object.assign(new Error('overloaded'), { status: 429 }) } } }) as never)
    await expect(busy.decide([], { turnosRestantes: 5 })).rejects.not.toBeInstanceOf(ProbeAiDisabledError)
    const noKey = new SpyProbeModel(async () => ({ config: { apiKey: '' } }) as never)
    await expect(noKey.decide([], { turnosRestantes: 5 })).rejects.toBeInstanceOf(ProbeAiDisabledError)
  })
})

describe('SpyProbeModel com OpenAI', () => {
  const anthropicUnused = async () => { throw new Error('não deveria ler as configurações da Anthropic') }
  it('usa a chave da OpenAI com saída JSON; sem saldo ou chave inválida para a sonda; 5xx tenta depois', async () => {
    const calls: Array<{ url: string; body: { model: string; response_format: unknown } }> = []
    const ok = new SpyProbeModel(anthropicUnused as never, undefined, { apiKey: 'sk', model: 'gpt-x', fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init!.body)) })
      return Response.json({ choices: [{ message: { content: '{"acao":"responder","mensagens":["oi, quanto custa?"]}' } }] })
    } })
    expect(await ok.decide([{ de: 'oferta', texto: 'Olá!' }], { turnosRestantes: 3 })).toMatchObject({ acao: 'responder', mensagens: ['oi, quanto custa?'] })
    expect(calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/chat/completions', body: { model: 'gpt-x', response_format: { type: 'json_object' } } })

    const quota = new SpyProbeModel(anthropicUnused as never, undefined, { apiKey: 'sk', model: 'm', fetch: async () => Response.json({ error: { code: 'insufficient_quota', message: 'sem saldo' } }, { status: 429 }) })
    await expect(quota.decide([], { turnosRestantes: 1 })).rejects.toBeInstanceOf(ProbeAiDisabledError)
    const bad = new SpyProbeModel(anthropicUnused as never, undefined, { apiKey: 'sk', model: 'm', fetch: async () => Response.json({ error: { message: 'invalid key' } }, { status: 401 }) })
    await expect(bad.decide([], { turnosRestantes: 1 })).rejects.toBeInstanceOf(ProbeAiDisabledError)
    const down = new SpyProbeModel(anthropicUnused as never, undefined, { apiKey: 'sk', model: 'm', fetch: async () => new Response('x', { status: 503 }) })
    await expect(down.decide([], { turnosRestantes: 1 })).rejects.not.toBeInstanceOf(ProbeAiDisabledError)
  })
})

describe('ramificações', () => {
  it('várias sondas na mesma oferta: uma por caminho e cada uma num chip; atraso da abertura', async () => {
    const { session, offer, store } = await fixture()
    const [chip2] = await db.insert(sessions).values({ name: 'chip2', phone: '+5531900000002', status: 'STABLE' }).returning()
    const main = await store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'a' })
    expect(main.branch).toBe('principal')
    const obj = await store.create({ offerId: offer.id, sessionId: chip2!.id, branch: 'objecao', startInMs: 5 * 60_000, createdBy: 'a' })
    expect(obj).toMatchObject({ branch: 'objecao', replyDueAt: new Date(now + 5 * 60_000) })
    await expect(store.create({ offerId: offer.id, sessionId: session.id, branch: 'sumiu', createdBy: 'a' })).rejects.toThrow(/já está sondando/)
    const [chip3] = await db.insert(sessions).values({ name: 'chip3', phone: '+5531900000003', status: 'STABLE' }).returning()
    await expect(store.create({ offerId: offer.id, sessionId: chip3!.id, branch: 'objecao', createdBy: 'a' })).rejects.toThrow(/"objecao" ativa/)
  })
})
