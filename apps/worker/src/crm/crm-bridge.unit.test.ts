// Integração CRM (A1/A3/A7/A8) no worker completo: Postgres local (banco descartável), Redis local isolado por
// prefixo/stream e WA_TRANSPORT=fake. Com CRM_BRIDGE desligado nada muda (alvos novos = UNKNOWN_METHOD, stream mudo).
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { Redis } from 'ioredis'
import { SessionLimitsService } from '@wsm/core'
import { auditLogs, contacts, createDb, createTempDatabase, messages, type Database, type TempDatabase } from '@wsm/db'
import { startWorker, type WorkerHandle } from '../boot/start'

let tmp: TempDatabase
let db: Database
let redis: Redis
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const STREAM = `test:crm-bridge:wsm:events:${randomBytes(4).toString('hex')}`

function env(extra: Record<string, string> = {}) {
  return {
    DATABASE_URL: tmp.url,
    REDIS_URL,
    CREDENTIALS_KEY: randomBytes(32).toString('base64'),
    INTERNAL_TOKEN: 'itok',
    WORKER_HEALTH_PORT: '0',
    WORKER_INTERNAL_PORT: '0',
    WORKER_INTERNAL_HOST: '127.0.0.1',
    QUEUE_PREFIX: `wsmtest${randomBytes(4).toString('hex')}`,
    ANTIBAN_MODE: 'passthrough',
    LOG_LEVEL: 'silent',
    WA_TRANSPORT: 'fake',
    WA_EVENTS_STREAM: STREAM,
    CONVERSATIONS_AUTO_ROTATE: 'false',
    GROUP_AUTOMATION_AUTO_ENABLE: 'false',
    ...extra,
  }
}

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: false, prefix: 'wsm_worker_crm' })
  db = createDb(tmp.url, { max: 2 })
  redis = new Redis(REDIS_URL)
})

afterAll(async () => {
  await redis?.del(STREAM)
  await redis?.quit()
  await db?.$client.end()
  await tmp?.drop()
})

interface RpcBody {
  result?: Record<string, unknown> & { id?: string; status?: string }
  error?: { name: string; code?: string; status?: number; gate?: string; message: string }
}

async function rpcRaw(w: WorkerHandle, target: string, method: string, args: unknown[]) {
  const res = await fetch(`${w.internal.url}/internal/rpc`, {
    method: 'POST',
    headers: { authorization: 'Bearer itok', 'content-type': 'application/json' },
    body: JSON.stringify({ target, method, args }),
  })
  return { status: res.status, body: (await res.json()) as RpcBody }
}
const rpc = async (w: WorkerHandle, target: string, method: string, ...args: unknown[]) => (await rpcRaw(w, target, method, args)).body

const fakePost = (w: WorkerHandle, path: string, body: unknown = {}) =>
  fetch(`${w.internal.url}/internal/fake/sessions/${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer itok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function connectedSession(w: WorkerHandle, phone: string): Promise<string> {
  const id = (await rpc(w, 'sessions', 'create', { name: `crm-${phone}`, phone })).result!.id as string
  await rpc(w, 'sessions', 'startQr', id)
  await until(async () => (await fakePost(w, `${id}/qr`)).ok, (ok) => ok)
  await fakePost(w, `${id}/open`)
  await until(() => rpc(w, 'sessions', 'get', id), (r) => r.result?.status === 'WARMING')
  return id
}

const streamEvents = async () =>
  (await redis.xrange(STREAM, '-', '+')).map(([, fields]) => JSON.parse(fields[fields.indexOf('event') + 1]!) as Record<string, unknown> & { type: string; session_id: string })

const CRM_TARGETS: Array<[string, string]> = [
  ['messages', 'send'],
  ['messages', 'sendGroup'],
  ['media', 'download'],
  ['presence', 'update'],
  ['contacts', 'recordConsent'],
  ['contacts', 'optOut'],
  ['contacts', 'list'],
]

describe('integração CRM no worker', () => {
  it('CRM_BRIDGE desligado: alvos novos respondem UNKNOWN_METHOD e nada vai para o stream', async () => {
    const w = await startWorker({ env: env(), healthIntervalMs: 0 })
    try {
      expect(w.config.crmBridge).toBe(false)
      for (const [target, method] of CRM_TARGETS) {
        const res = await rpcRaw(w, target, method, [])
        expect(res.status, `${target}.${method}`).toBe(400)
        expect(res.body.error).toMatchObject({ code: 'UNKNOWN_METHOD' })
      }
      await connectedSession(w, '+5511999991001')
    } finally {
      await w.stop()
    }
    expect(await redis.xlen(STREAM)).toBe(0)
  })

  it('CRM_BRIDGE=on: a sonda vazia é recusada sem efeito colateral e a lista continua fechada', async () => {
    const w = await startWorker({ env: env({ CRM_BRIDGE: 'on' }), healthIntervalMs: 0 })
    try {
      const before = { contacts: (await db.select().from(contacts)).length, messages: (await db.select().from(messages)).length }
      for (const [target, method] of CRM_TARGETS) {
        const res = await rpcRaw(w, target, method, [])
        expect(res.status, `${target}.${method}`).toBe(200)
        expect(res.body.error, `${target}.${method}`).toBeDefined()
        expect(res.body.error!.code).not.toBe('UNKNOWN_METHOD')
      }
      expect((await db.select().from(contacts)).length).toBe(before.contacts)
      expect((await db.select().from(messages)).length).toBe(before.messages)
      // Fora da lista: continua UNKNOWN_METHOD (react, markRead, meta.capabilities, protótipo).
      for (const [target, method] of [['messages', 'react'], ['messages', 'markRead'], ['meta', 'capabilities'], ['media', 'constructor']] as const) {
        expect((await rpcRaw(w, target, method, [])).body.error).toMatchObject({ code: 'UNKNOWN_METHOD' })
      }
    } finally {
      await w.stop()
    }
  })

  it('CRM_BRIDGE=on: envio pelo SendPipeline (gates, idempotência, limites), mídia, presença, agenda e eventos', async () => {
    await redis.del(STREAM)
    const w = await startWorker({ env: env({ CRM_BRIDGE: 'on' }), healthIntervalMs: 0 })
    try {
      const id = await connectedSession(w, '+5511999992001')
      const phone = '+5511977770001'
      const actor = 'crm:user-1'

      // A7: sem consentimento o gate contactAllowed recusa; recordConsent libera (e audita).
      expect((await rpc(w, 'messages', 'send', { sessionId: id, phone, content: { text: 'oi' }, actor })).error).toMatchObject({
        name: 'SendRejectedError',
        code: 'CONTACT_NOT_ALLOWED',
        status: 403,
        gate: 'contactAllowed',
      })
      expect(await rpc(w, 'contacts', 'recordConsent', { phone, source: 'import', actor, name: 'Ana' })).toEqual({ result: null })
      const [contact] = await db.select().from(contacts).where(eq(contacts.phone, phone))
      expect(contact).toMatchObject({ consent: true, consentSource: 'import', optOut: false, name: 'Ana' })
      expect((await db.select().from(auditLogs).where(eq(auditLogs.action, 'contact.consent')))[0]).toMatchObject({ actor, targetId: contact!.id })
      expect((await rpc(w, 'contacts', 'recordConsent', { phone, source: 'whatever' })).error).toMatchObject({ code: 'VALIDATION_ERROR' })

      // A8: gates na ordem do pipeline.
      expect((await rpc(w, 'messages', 'send', { sessionId: id, phone, content: { text: 'x' } })).error).toMatchObject({ code: 'UNAUTHORIZED', status: 401, gate: 'auth' })
      expect((await rpc(w, 'messages', 'send', { sessionId: 'missing', phone, content: { text: 'x' }, actor })).error).toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404 })
      expect((await rpc(w, 'messages', 'send', { sessionId: id, phone, content: { location: { latitude: 1, longitude: 2 } }, actor })).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      })
      expect((await rpc(w, 'messages', 'sendGroup', { sessionId: id, groupId: 'not-a-group', content: { text: 'x' }, actor })).error).toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      })

      // Envio + idempotência (quoted/viewOnce aceitos e ignorados): o mesmo clientMessageId devolve a mesma mensagem.
      const req = { sessionId: id, phone, content: { text: 'uma vez' }, actor, clientMessageId: 'cm-1', quoted: 'WA0', viewOnce: false }
      const first = (await rpc(w, 'messages', 'send', req)).result!
      expect(first).toMatchObject({ sessionId: id, phone, status: 'queued', attempts: 0, transportMessageId: null, clientMessageId: 'cm-1' })
      const second = (await rpc(w, 'messages', 'send', req)).result!
      expect(second.id).toBe(first.id)
      expect(await redis.get(`${w.config.queuePrefix}:crm:client-msg:${id}:cm-1`)).toBe(first.id)
      const sent = await until(() => rpc(w, 'messages', 'get', first.id), (r) => r.result?.status === 'sent')
      expect((await db.select().from(messages).where(eq(messages.sessionId, id))).filter((m) => m.direction === 'outbound')).toHaveLength(1)
      const state = (await (await fetch(`${w.internal.url}/internal/fake/sessions/${id}/state`, { headers: { authorization: 'Bearer itok' } })).json()) as {
        sent: Array<{ to: string; content: unknown }>
      }
      expect(state.sent).toEqual([expect.objectContaining({ to: '5511977770001@s.whatsapp.net', content: { text: 'uma vez' } })])

      // Limite de taxa da sessão NÃO vale para o CRM: o envio passa com o limite estourado, sai com origin crm e
      // não conta para os envios do próprio ai-manager.
      expect(sent.result).toMatchObject({ status: 'sent' })
      await new SessionLimitsService(db).set(id, { perMinute: 1 })
      const over = (await rpc(w, 'messages', 'send', { ...req, clientMessageId: 'cm-2' })).result!
      expect(over).toMatchObject({ status: 'queued' })
      expect((await db.select().from(messages).where(eq(messages.id, String(over.id))))[0]!.origin).toBe('crm')
      expect(await new SessionLimitsService(db).countOutbound(id, new Date(0))).toBe(0)
      await until(() => rpc(w, 'messages', 'get', String(over.id)), (r) => r.result?.status === 'sent')
      await new SessionLimitsService(db).set(id, { perMinute: 50 })

      // Opt-out bloqueia o envio; consentimento de import NÃO reverte; manual reverte.
      expect(await rpc(w, 'contacts', 'optOut', { phone, reason: 'pediu', actor })).toEqual({ result: null })
      expect((await rpc(w, 'messages', 'send', { ...req, clientMessageId: 'cm-3' })).error).toMatchObject({ code: 'CONTACT_NOT_ALLOWED', status: 403 })
      await rpc(w, 'contacts', 'recordConsent', { phone, source: 'import' })
      expect((await rpc(w, 'messages', 'send', { ...req, clientMessageId: 'cm-4' })).error).toMatchObject({ code: 'CONTACT_NOT_ALLOWED' })
      await rpc(w, 'contacts', 'recordConsent', { phone, source: 'manual', actor })
      expect((await rpc(w, 'messages', 'send', { ...req, clientMessageId: 'cm-5' })).result).toMatchObject({ status: 'queued' })

      // A3: mídia sob demanda e presença pelo transporte da sessão.
      const fake = w.fake!.require(id)
      fake.media.set('WA-MEDIA-1', new TextEncoder().encode('bytes-da-midia'))
      const media = (await rpc(w, 'media', 'download', id, { session_id: id, message_id: 'WA-MEDIA-1', mime: 'image/jpeg', key: null, status: 'pending' })).result!
      expect(media).toMatchObject({ mime: 'image/jpeg', size: 14, key: null })
      expect(Buffer.from(String(media.data), 'base64').toString()).toBe('bytes-da-midia')
      expect(media.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect((await rpc(w, 'media', 'download', id, { message_id: 'nao-existe' })).error).toMatchObject({ code: 'MEDIA_NOT_FOUND' })
      expect(await rpc(w, 'presence', 'update', id, phone, 'recording')).toEqual({ result: null })
      expect(fake.presences).toEqual([{ to: '5511977770001@s.whatsapp.net', kind: 'recording' }])
      expect((await rpc(w, 'presence', 'update', id, phone, 'dancing')).error).toMatchObject({ code: 'VALIDATION_ERROR' })

      // A7: agenda da sessão (transporte) no formato WaContactSummary.
      fake.contacts = [{ jid: '5511977770001@s.whatsapp.net', phone, lid: null, name: 'Ana', pushName: 'Aninha' }]
      expect((await rpc(w, 'contacts', 'list', id)).result).toEqual([{ jid: '5511977770001@s.whatsapp.net', phone, lid: null, name: 'Ana', pushName: 'Aninha' }])

      // A1: inbound (com o id pedido pelo controle do fake) e status chegam ao stream.
      expect((await (await fakePost(w, `${id}/receive`, { id: 'WA-IN-1', from: '5511977770001@s.whatsapp.net', text: 'olá' })).json())).toMatchObject({ id: 'WA-IN-1' })
      const events = await until(streamEvents, (list) => list.some((e) => e.type === 'message.inbound'))
      const mine = events.filter((e) => e.session_id === id)
      expect(mine.map((e) => e.type)).toEqual(expect.arrayContaining(['session.state', 'session.qr', 'session.connection', 'message.status', 'message.inbound']))
      expect(mine.find((e) => e.type === 'session.state')).toMatchObject({ v: 1, from: 'NEW', to: 'WARMING' })
      expect(mine.find((e) => e.type === 'message.inbound')).toMatchObject({
        v: 1,
        message: { id: 'WA-IN-1', from: '5511977770001@s.whatsapp.net', from_me: false, text: 'olá', type: 'conversation' },
      })
      expect(mine.filter((e) => e.type === 'message.status' && e.message_id === first.id).map((e) => e.status)).toEqual(
        expect.arrayContaining(['queued', 'processing', 'sent']),
      )
      expect(mine.find((e) => e.type === 'message.status' && e.status === 'sent' && e.message_id === first.id)).toMatchObject({
        transport_message_id: sent.result!.transportMessageId,
      })
      for (const e of events) expect(Number.isNaN(Date.parse(String(e.at)))).toBe(false)
    } finally {
      await w.stop()
    }
  })
})
