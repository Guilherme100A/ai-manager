// attachAi + SessionManager (T05) com Postgres local (banco descartável), FakeTransport e provedor fake.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { AiAssistant, generateCredentialsKey, resetCredentialsCrypto, SessionLinkStore, SessionRouter, SendPipeline, MessageStore, toMessageView, type AiGenerateRequest, type AiProvider } from '@wsm/core'
import { contacts, createDb, createTempDatabase, messages, sessions, suggestions, type Database, type TempDatabase } from '@wsm/db'
import { SessionManager } from '../sessions/manager'
import { createFakeTransportFactory, type FakeTransportFactory } from '../sessions/transport-factory'
import { attachAi, type AiAttachment } from './attach'

let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const FROM = '5511988887777@s.whatsapp.net'

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_worker_ai' })
  db = createDb(tmp.url, { max: 6 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

let fakes: FakeTransportFactory
let manager: SessionManager
let calls: AiGenerateRequest[]
let failProvider: boolean
let attachment: AiAttachment | undefined
const provider: AiProvider = {
  generate: async (req) => {
    calls.push(req)
    if (failProvider) throw new Error('provider down')
    return { intent: 'pricing', confidence: 0.9, text: 'Vou verificar os valores.' }
  },
}
const assistant = () => new AiAssistant({ provider, config: { smallModel: 'small-m', largeModel: 'large-m' } })

beforeEach(async () => {
  await db.delete(sessions)
  await db.delete(contacts)
  fakes = createFakeTransportFactory()
  calls = []
  failProvider = false
  manager = new SessionManager({ db, transportFactory: fakes.factory, sleep: async () => {}, logger: quiet })
})

afterEach(async () => {
  attachment?.stop()
  attachment = undefined
  await manager.stop()
})

async function connected() {
  const s = await manager.create({ name: 's', phone: '+5511999990001' })
  await manager.startQr(s.id)
  fakes.last(s.id)!.open()
  await manager.whenIdle()
  return s.id
}

const suggestionRows = () => db.select().from(suggestions)
const inboundRows = () => db.select().from(messages).where(eq(messages.direction, 'inbound'))

describe('attachAi (T13)', () => {
  it('roteador integrado: A recebe, B enfileira para o contato; duplicata e opt-out não enviam', async () => {
    const a = await connected()
    const b = await connected()
    await db.insert(contacts).values({ phone: '+5511988887777', consent: true })
    const links = new SessionLinkStore(db)
    await links.create({ sourceSessionId: a, targetSessionId: b, enabled: true, rules: { matchText: 'oi', replyText: 'Olá!' }, createdBy: 'test' })
    const store = new MessageStore(db)
    const pipeline = new SendPipeline({ db, queue: { enqueue: async (input) => toMessageView(await store.create(input)) } })
    const router = new SessionRouter(links.dependencies((request) => pipeline.send(request)))
    attachment = attachAi(manager, { db, assistant: assistant(), logger: quiet, routeIncoming: (event) => router.route(event) })
    await attachment.idle()
    const msg = fakes.last(a)!.receive({ from: FROM, text: 'oi' })
    await attachment.idle()
    const rows = await db.select().from(messages).where(eq(messages.direction, 'outbound'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: b, phone: '+5511988887777', content: { text: 'Olá!' } })
    expect(await suggestionRows()).toHaveLength(0)
    expect((await links.runs())[0]).toMatchObject({ status: 'queued', messageId: rows[0]!.id })
    await attachment.handleIncoming(a, msg)
    fakes.last(a)!.receive({ from: FROM, text: 'SAIR' })
    await attachment.idle()
    fakes.last(a)!.receive({ from: FROM, text: 'oi' })
    await attachment.idle()
    expect(await db.select().from(messages).where(eq(messages.direction, 'outbound'))).toHaveLength(1)
  })

  it('não chama roteador para mensagem própria, grupo ou opt-out', async () => {
    const routeIncoming = vi.fn(async () => 1)
    attachment = attachAi(manager, { db, assistant: assistant(), logger: quiet, routeIncoming })
    const id = await connected()
    const t = fakes.last(id)!
    t.receive({ from: FROM, text: 'oi', fromMe: true })
    t.receive({ from: '123@g.us', text: 'oi' })
    t.receive({ from: FROM, text: 'SAIR' })
    await attachment.idle()
    expect(routeIncoming).not.toHaveBeenCalled()
  })

  it('mensagem recebida → persiste inbound → sugestão pending_approval; nada é enviado', async () => {
    attachment = attachAi(manager, { db, assistant: assistant(), logger: quiet })
    const id = await connected()
    const t = fakes.last(id)!
    const msg = t.receive({ from: FROM, text: 'Quanto custa?' })
    await attachment.idle()

    const [inbound] = await inboundRows()
    expect(inbound).toMatchObject({ sessionId: id, phone: '+5511988887777', transportMessageId: msg.id, content: { text: 'Quanto custa?' } })
    const [s] = await suggestionRows()
    expect(s).toMatchObject({ sessionId: id, inboundMessageId: inbound!.id, intent: 'pricing', model: 'small-m', status: 'pending_approval' })
    expect(calls.map((c) => c.text)).toEqual(['Quanto custa?'])
    expect(t.sent).toEqual([])
    expect(await db.select().from(messages).where(eq(messages.direction, 'outbound'))).toHaveLength(0)
  })

  it('opt-out tem prioridade: marca o contato e não gera sugestão', async () => {
    attachment = attachAi(manager, { db, assistant: assistant(), logger: quiet })
    const id = await connected()
    fakes.last(id)!.receive({ from: FROM, text: 'SAIR' })
    await attachment.idle()
    expect(await inboundRows()).toHaveLength(1)
    expect(await suggestionRows()).toHaveLength(0)
    expect(calls).toHaveLength(0)
    const [c] = await db.select().from(contacts).where(eq(contacts.phone, '+5511988887777'))
    expect(c?.optOut).toBe(true)
  })

  it('ignora mensagens próprias e de grupo; mídia sem texto persiste sem sugestão; msg.id repetida não duplica', async () => {
    attachment = attachAi(manager, { db, assistant: assistant(), logger: quiet })
    const id = await connected()
    const t = fakes.last(id)!
    t.receive({ from: FROM, text: 'eu mesmo', fromMe: true })
    t.receive({ from: '120363000000000000@g.us', participant: FROM, text: 'grupo' })
    t.receive({ from: FROM, type: 'imageMessage', text: undefined })
    const dup = t.receive({ from: FROM, text: 'oi' })
    t.receive({ ...dup })
    await attachment.idle()
    expect(await inboundRows()).toHaveLength(2)
    expect(await suggestionRows()).toHaveLength(1)
    expect(calls.map((c) => c.text)).toEqual(['oi'])
  })

  it('pluga em sessões já conectadas e em reconexões; stop() para de processar', async () => {
    const id = await connected()
    attachment = attachAi(manager, { db, assistant: assistant(), logger: quiet })
    await attachment.idle()
    fakes.last(id)!.receive({ id: 'WA-1', from: FROM, text: 'primeira' })
    await attachment.idle()
    expect(await suggestionRows()).toHaveLength(1)

    await manager.restart(id)
    fakes.last(id)!.open()
    await manager.whenIdle()
    fakes.last(id)!.receive({ id: 'WA-2', from: FROM, text: 'depois do restart' })
    await attachment.idle()
    expect(await suggestionRows()).toHaveLength(2)

    attachment.stop()
    fakes.last(id)!.receive({ id: 'WA-3', from: FROM, text: 'após stop' })
    await attachment.idle()
    expect(await inboundRows()).toHaveLength(2)
  })

  it('provedor fora do ar: a sugestão sai do fallback, sem exceção', async () => {
    failProvider = true
    attachment = attachAi(manager, { db, assistant: assistant(), logger: quiet })
    const id = await connected()
    fakes.last(id)!.receive({ from: FROM, text: 'Bom dia' })
    await attachment.idle()
    const [s] = await suggestionRows()
    expect(s).toMatchObject({ intent: 'greeting', model: 'fallback', status: 'pending_approval' })
  })

  it('erro no processamento não derruba o worker (outcome error)', async () => {
    attachment = attachAi(manager, { db, assistant: assistant(), logger: quiet })
    const id = await connected()
    const outcome = await attachment.handleIncoming('00000000-0000-4000-8000-000000000000', {
      id: 'x',
      from: FROM,
      fromMe: false,
      timestamp: Date.now(),
      type: 'conversation',
      text: 'oi',
    })
    expect(outcome.kind).toBe('error')
    fakes.last(id)!.receive({ from: FROM, text: 'segue funcionando' })
    await attachment.idle()
    expect(await suggestionRows()).toHaveLength(1)
  })
})
