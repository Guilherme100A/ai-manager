// Sondas com Postgres local: travas da criação, histórico da conversa e janela do remarketing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import { auditLogs, contacts, createDb, createTempDatabase, messageEvents, messages, sessions, spyOffers, spyProbes, type Database, type TempDatabase } from '@wsm/db'
import { MessageStore, ProbeNotActiveForSendError, toMessageView } from '../queue/store'
import { SendPipeline } from '../send/pipeline'
import { parseDecision, ProbeAiDisabledError, SpyProbeModel } from './probe-model'
import { contentText, SPY_CONSENT_SOURCE, SpyProbeError, SpyProbeStore, type SpyProbeRow } from './probe-store'

let tmp: TempDatabase
let db: Database
let peer: Database
let observer: Database
let now = Date.parse('2026-10-20T12:00:00Z')

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_spy_probe' })
  db = createDb(tmp.url, { max: 1 })
  peer = createDb(tmp.url, { max: 1 })
  observer = createDb(tmp.url, { max: 1 })
})

afterAll(async () => {
  await Promise.all([db?.$client.end(), peer?.$client.end(), observer?.$client.end()])
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

async function backendPid(database: Database) {
  const { rows } = await database.$client.query<{ pid: number }>('select pg_backend_pid() as pid')
  return rows[0]!.pid
}

async function waitForBlock(blocked: () => Promise<boolean>) {
  const deadline = Date.now() + 4_000
  do {
    if (await blocked()) return
    await delay(10)
  } while (Date.now() < deadline)
  throw new Error('Expected PostgreSQL lock wait was not observed')
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

  it('serializa duas criações concorrentes disputando a quinta vaga do mesmo chip', async () => {
    const { session, offer, store } = await fixture()
    for (let i = 0; i < 4; i++) {
      const [previous] = await db.insert(spyOffers).values({ phone: `551199999000${i}` }).returning()
      await store.create({ offerId: previous!.id, sessionId: session.id, createdBy: 'a' })
    }
    const [other] = await db.insert(spyOffers).values({ phone: '5511999993333' }).returning()
    const [firstPid, secondPid] = await Promise.all([backendPid(db), backendPid(peer)])
    expect(firstPid).not.toBe(secondPid)
    const blocker = await observer.$client.connect()
    const { rows: [blocking] } = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
    let outcomes: Promise<PromiseSettledResult<SpyProbeRow>[]> | undefined
    try {
      await blocker.query('begin')
      await blocker.query('select id from sessions where id = $1 for no key update', [session.id])
      outcomes = Promise.allSettled([
        store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'quota-race' }),
        new SpyProbeStore(peer, () => now).create({ offerId: other!.id, sessionId: session.id, createdBy: 'quota-race' }),
      ])
      // O segundo pode ficar atrás do primeiro na fila de trava do PostgreSQL.
      await waitForBlock(async () => {
        const { rows: [locks] } = await blocker.query<{ first: number[]; second: number[] }>(
          'select pg_blocking_pids($1) as first, pg_blocking_pids($2) as second', [firstPid, secondPid],
        )
        return (locks!.first.includes(blocking!.pid) && (locks!.second.includes(blocking!.pid) || locks!.second.includes(firstPid)))
          || (locks!.second.includes(blocking!.pid) && locks!.first.includes(secondPid))
      })
    } finally {
      await blocker.query('rollback').finally(() => blocker.release())
      await outcomes
    }
    const results = await outcomes!
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    const losingIndex = results.findIndex(({ status }) => status === 'rejected')
    expect(results[losingIndex]).toMatchObject({ reason: { code: 'DAILY_LIMIT' } })
    const losingOffer = [offer, other!][losingIndex]!
    expect(await db.select().from(spyOffers).where(eq(spyOffers.id, losingOffer.id))).toEqual([losingOffer])
    expect(await db.select().from(contacts).where(eq(contacts.phone, `+${losingOffer.phone}`))).toEqual([])
    expect(await db.select().from(auditLogs).where(eq(auditLogs.actor, 'quota-race'))).toHaveLength(1)
    expect(await db.select().from(spyProbes).where(eq(spyProbes.sessionId, session.id))).toHaveLength(5)
  }, 15_000)

  it.each(['branch', 'session'] as const)('reverte a mutação de consentimento quando o índice ativo de %s rejeita', async (conflict) => {
    const { session, offer, store } = await fixture()
    const [otherChip] = await db.insert(sessions).values({ name: 'chip2', status: 'STABLE' }).returning()
    const phone = `+${offer.phone}`
    const [existing] = await db.insert(spyProbes).values({ offerId: offer.id, sessionId: session.id, phone, createdBy: 'seed' }).returning()
    if (conflict === 'session') await db.insert(contacts).values({ phone, name: 'Contato anterior', consent: false, consentSource: 'anterior' })
    const previousContacts = await db.select().from(contacts)
    const previousAudit = await db.select().from(auditLogs)

    const create = store.create({ offerId: offer.id, createdBy: 'duplicate', ...(conflict === 'branch'
      ? { sessionId: otherChip!.id, branch: 'principal' }
      : { sessionId: session.id, branch: 'objecao' }) })
    await expect(create).rejects.toMatchObject({
      code: 'PROBE_ACTIVE',
      message: expect.stringMatching(conflict === 'branch' ? /"principal" ativa/ : /já está sondando/),
    })
    expect(await db.select().from(contacts)).toEqual(previousContacts)
    expect(await db.select().from(auditLogs)).toEqual(previousAudit)
    expect(await db.select().from(spyOffers)).toEqual([offer])
    expect(await db.select().from(spyProbes)).toEqual([existing])
  })

  it('duas criações da mesma ramificação em chips distintos registram uma única sonda', async () => {
    const { session, offer, store } = await fixture()
    const [otherChip] = await db.insert(sessions).values({ name: 'chip2', status: 'STABLE' }).returning()
    const results = await Promise.allSettled([
      store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'branch-race' }),
      new SpyProbeStore(peer, () => now).create({ offerId: offer.id, sessionId: otherChip!.id, createdBy: 'branch-race' }),
    ])
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    const losingIndex = results.findIndex(({ status }) => status === 'rejected')
    expect(results[losingIndex]).toMatchObject({ reason: { code: 'PROBE_ACTIVE', message: expect.stringMatching(/"principal" ativa/) } })
    expect(await db.select().from(spyOffers)).toMatchObject([{ id: offer.id, status: 'sondando' }])
    expect(await db.select().from(spyProbes)).toHaveLength(1)
    expect(await db.select().from(contacts)).toHaveLength(1)
    expect(await db.select().from(auditLogs).where(eq(auditLogs.actor, 'branch-race'))).toHaveLength(1)
  })

  it('reverte também a sonda e o status da oferta se a auditoria rejeitar', async () => {
    const { session, offer, store } = await fixture()
    await db.$client.query("alter table audit_logs add constraint test_audit_reject check (actor <> 'reject-audit')")
    try {
      await expect(store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'reject-audit' })).rejects.toMatchObject({
        cause: { constraint: 'test_audit_reject' },
      })
    } finally {
      await db.$client.query('alter table audit_logs drop constraint test_audit_reject')
    }
    expect(await db.select().from(contacts)).toEqual([])
    expect(await db.select().from(spyProbes)).toEqual([])
    expect(await db.select().from(spyOffers)).toEqual([offer])
    expect(await db.select().from(auditLogs).where(eq(auditLogs.actor, 'reject-audit'))).toEqual([])
  })

  it('stop espera a aceitação em curso e veda novas mensagens sem tocar a fila de terceiros', async () => {
    const { session, offer, store } = await fixture()
    const probe = await store.create({ offerId: offer.id, sessionId: session.id, createdBy: 'a' })
    const [contact] = await db.select().from(contacts)
    const sender = new MessageStore(db)
    const send = new SendPipeline({
      db,
      queue: { enqueue: async (input) => toMessageView(await sender.create(input)) },
    })
    const request = { sessionId: session.id, phone: probe.phone, contactId: contact!.id, content: { text: 'parte' }, actor: 'spy-probe', origin: 'spy' as const, probeId: probe.id }
    const [otherChip] = await db.insert(sessions).values({ name: 'chip2', status: 'STABLE' }).returning()
    await expect(sender.create({ ...request, sessionId: otherChip!.id })).rejects.toBeInstanceOf(ProbeNotActiveForSendError)
    await expect(sender.create({ ...request, phone: '+5511000000000' })).rejects.toBeInstanceOf(ProbeNotActiveForSendError)
    const unrelated = await sender.create({ sessionId: session.id, phone: probe.phone, content: { text: 'terceiro' } })

    const [sendPid, stopPid] = await Promise.all([backendPid(db), backendPid(peer)])
    expect(sendPid).not.toBe(stopPid)
    const blocker = await observer.$client.connect()
    const { rows: [blocking] } = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
    const blockedBy = async (pid: number) => (await blocker.query<{ pids: number[] }>('select pg_blocking_pids($1) as pids', [pid])).rows[0]!.pids
    const stopper = new SpyProbeStore(peer, () => now)
    let acceptance: Promise<PromiseSettledResult<Awaited<ReturnType<SendPipeline['send']>>>[]> | undefined
    let stopping: Promise<PromiseSettledResult<SpyProbeRow | undefined>[]> | undefined
    try {
      await blocker.query('begin')
      // INSERT do evento acontece após a trava da sonda, ainda antes do commit de aceitação.
      await blocker.query('lock table message_events in share mode')
      acceptance = Promise.allSettled([send.send(request)])
      await waitForBlock(async () => (await blockedBy(sendPid)).includes(blocking!.pid))
      stopping = Promise.allSettled([stopper.end(probe.id, 'parada', 'stop')])
      await waitForBlock(async () => (await blockedBy(stopPid)).includes(sendPid))
    } finally {
      await blocker.query('rollback').finally(() => blocker.release())
      await Promise.all([acceptance, stopping])
    }
    const [accepted] = await acceptance!
    const [stopped] = await stopping!
    expect(accepted).toMatchObject({ status: 'fulfilled', value: { status: 'queued' } })
    expect(stopped).toMatchObject({ status: 'fulfilled', value: { status: 'parada' } })
    await expect(send.send(request)).rejects.toBeInstanceOf(ProbeNotActiveForSendError)
    await store.inboundSeen(probe.id, new Date(now), 0)
    await store.postpone(probe.id, 1000)
    await store.replied(probe.id, { turns: 99, sentAt: new Date(now) })
    expect(await store.get(probe.id)).toMatchObject({ status: 'parada', endedReason: 'stop', turns: 0, replyDueAt: null, lastInboundAt: null, lastOutboundAt: null })
    expect(await db.select({ status: messages.status }).from(messages)).toEqual([{ status: 'queued' }, { status: 'queued' }])
    expect(await sender.get(unrelated.id)).toMatchObject({ status: 'queued', content: { text: 'terceiro' } })
    expect(await db.select({ to: messageEvents.toStatus }).from(messageEvents)).toEqual([{ to: 'queued' }, { to: 'queued' }])
  }, 15_000)
  it('histórico com as duas pontas, mensagem mais recente e encerramento da escuta', async () => {
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
    expect((await store.get(probe.id))!.listenUntil).toBeNull()
    expect((await db.select().from(spyOffers))[0]!.status).toBe('completa')
    expect(await store.listening(session.id, probe.phone)).toBeUndefined()
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
