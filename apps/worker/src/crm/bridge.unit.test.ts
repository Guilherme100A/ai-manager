// Integração CRM: peças sem banco (idempotência, conteúdo aceito, montagem condicional dos alvos na lista fechada).
import { describe, expect, it, vi } from 'vitest'
import { FakeTransport, SendRejectedError, type MessageView } from '@wsm/core'
import type { Database } from '@wsm/db'
import { bridgeHandlers, createInternalApp, type BridgeTargets } from '../boot/internal-server'
import { assertSupportedContent, createCrmBridgeTargets } from './bridge'
import { ClientMessageDedupe, DedupeConflictError, type DedupeRedis } from './dedupe'

class MemoryRedis implements DedupeRedis {
  readonly data = new Map<string, string>()
  readonly ttls = new Map<string, number>()
  async set(key: string, value: string, ...args: (string | number)[]) {
    if (args.includes('NX') && this.data.has(key)) return null
    this.data.set(key, value)
    const ex = args.indexOf('EX')
    if (ex >= 0) this.ttls.set(key, Number(args[ex + 1]))
    return 'OK'
  }
  async get(key: string) {
    return this.data.get(key) ?? null
  }
  async del(key: string) {
    return this.data.delete(key) ? 1 : 0
  }
}

const view = (id: string): MessageView => ({ id, sessionId: 's', contactId: null, phone: '+5511999999999', content: { text: 'x' }, status: 'queued', attempts: 0 }) as unknown as MessageView

describe('ClientMessageDedupe (A8)', () => {
  it('envia uma vez por (sessão, clientMessageId); TTL e prefixo na chave; sem id sempre envia', async () => {
    const redis = new MemoryRedis()
    const dedupe = new ClientMessageDedupe(redis, { prefix: 'wsm', ttlSeconds: 60 })
    const send = vi.fn(async () => view(`m${send.mock.calls.length}`))
    const lookup = vi.fn(async (id: string) => view(id))
    const a = await dedupe.run('s', 'c1', send, lookup)
    const b = await dedupe.run('s', 'c1', send, lookup)
    expect(b.id).toBe(a.id)
    expect(send).toHaveBeenCalledTimes(1)
    expect(redis.data.get('wsm:crm:client-msg:s:c1')).toBe(a.id)
    expect(redis.ttls.get('wsm:crm:client-msg:s:c1')).toBe(60)
    await dedupe.run('s2', 'c1', send, lookup)
    await dedupe.run('s', undefined, send, lookup)
    await dedupe.run('s', undefined, send, lookup)
    expect(send).toHaveBeenCalledTimes(4)
  })

  it('falha libera a reserva; concorrente espera o primeiro; reserva presa vira CONFLICT', async () => {
    const redis = new MemoryRedis()
    const dedupe = new ClientMessageDedupe(redis, { waitMs: 50, pollMs: 5 })
    await expect(dedupe.run('s', 'c', async () => { throw new SendRejectedError('RATE_LIMIT', 'x') }, async (id) => view(id))).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(redis.data.size).toBe(0)

    let release!: () => void
    const slow = () => new Promise<MessageView>((r) => { release = () => r(view('m-slow')) })
    const first = dedupe.run('s', 'c', slow, async (id) => view(id))
    await new Promise((r) => setTimeout(r, 5))
    const second = dedupe.run('s', 'c', async () => view('never'), async (id) => view(id))
    release()
    expect((await first).id).toBe('m-slow')
    expect((await second).id).toBe('m-slow')

    redis.data.set('wsm:crm:client-msg:s:stuck', 'pending')
    await expect(dedupe.run('s', 'stuck', async () => view('x'), async (id) => view(id))).rejects.toBeInstanceOf(DedupeConflictError)
  })
})

describe('assertSupportedContent', () => {
  it('aceita o que o transporte do ai-manager envia e recusa o resto com VALIDATION_ERROR', () => {
    for (const ok of [{ text: 'oi' }, { image: { url: 'https://x/a.jpg' }, caption: 'c' }, { document: { url: 'u' }, mimetype: 'application/pdf' }, { sticker: { url: 'u' } }]) {
      expect(() => assertSupportedContent(ok)).not.toThrow()
    }
    for (const bad of [undefined, 'oi', { text: '' }, { location: { latitude: 1, longitude: 1 } }, { react: { messageId: 'x', emoji: '👍' } }, { image: {} }, { document: { url: 'u' } }]) {
      expect(() => assertSupportedContent(bad)).toThrow(expect.objectContaining({ name: 'SendRejectedError', code: 'VALIDATION_ERROR' }))
    }
  })
})

const baseTargets = (): BridgeTargets => ({
  sessions: { getTransport: () => undefined, isConnected: () => false } as unknown as BridgeTargets['sessions'],
  messages: { get: vi.fn(), list: vi.fn(), events: vi.fn(), cancel: vi.fn(), enqueue: vi.fn() },
  health: { getHealth: vi.fn() },
})

describe('bridgeHandlers com e sem os alvos do CRM', () => {
  it('sem montar: nenhum alvo novo na lista; montado: aparecem só os sete', () => {
    const without = bridgeHandlers(baseTargets())
    expect(Object.keys(without).sort()).toEqual(['health', 'messages', 'sessions'])
    expect(Object.keys(without.messages!)).not.toContain('send')

    const transport = new FakeTransport()
    const crm = createCrmBridgeTargets({ db: {} as Database, queue: { enqueue: vi.fn(), get: vi.fn() } as never, getTransport: () => transport, redis: new MemoryRedis(), pipeline: { send: vi.fn(), sendGroup: vi.fn() } })
    const t = baseTargets()
    const withCrm = bridgeHandlers({ ...t, messages: { ...t.messages, ...crm.messages }, media: crm.media, presence: crm.presence, contacts: crm.contacts })
    expect(Object.keys(withCrm).sort()).toEqual(['contacts', 'health', 'media', 'messages', 'presence', 'sessions'])
    expect(Object.keys(withCrm.media!)).toEqual(['download'])
    expect(Object.keys(withCrm.presence!)).toEqual(['update'])
    expect(Object.keys(withCrm.contacts!).sort()).toEqual(['list', 'optOut', 'recordConsent'])
    expect(Object.keys(withCrm.messages!)).toEqual(expect.arrayContaining(['send', 'sendGroup']))
  })

  it('pela rota: sessão desconectada responde TransportNotConnectedError; args vazios não chamam o pipeline', async () => {
    const pipeline = { send: vi.fn(), sendGroup: vi.fn() }
    const crm = createCrmBridgeTargets({ db: {} as Database, queue: { enqueue: vi.fn(), get: vi.fn() } as never, getTransport: () => undefined, redis: new MemoryRedis(), pipeline })
    const t = baseTargets()
    const app = createInternalApp({ token: 'itok', targets: { ...t, messages: { ...t.messages, ...crm.messages }, media: crm.media, presence: crm.presence, contacts: crm.contacts } })
    const call = async (target: string, method: string, args: unknown[]) =>
      (await app.request('/internal/rpc', { method: 'POST', headers: { authorization: 'Bearer itok', 'content-type': 'application/json' }, body: JSON.stringify({ target, method, args }) })).json() as Promise<{ error?: { name: string; code?: string } }>
    expect((await call('messages', 'send', [])).error).toMatchObject({ name: 'ValidationError', code: 'VALIDATION_ERROR' })
    expect(pipeline.send).not.toHaveBeenCalled()
    expect((await call('presence', 'update', ['s', '+5511999999999', 'composing'])).error).toMatchObject({ name: 'TransportNotConnectedError' })
    expect((await call('contacts', 'list', ['s'])).error).toMatchObject({ name: 'TransportNotConnectedError' })
    expect((await call('media', 'download', ['s', { message_id: 'm' }])).error).toMatchObject({ name: 'TransportNotConnectedError' })
  })
})
