// A1 (integração CRM): outbox WaEvent v1 no stream, com manager/fila/Redis falsos.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { FakeTransport, type MessageStatusEvent } from '@wsm/core'
import { attachEventOutbox, OUTBOX_EVENT_FIELD, type OutboxManager, type OutboxQueue } from './outbox'
import { toWaMessage, type WaEvent } from './wa-event'

const AT = new Date('2026-10-17T12:00:00.000Z')

class FakeRedis {
  readonly entries: Array<{ stream: string; args: (string | number)[] }> = []
  failures = 0
  async xadd(...args: (string | number)[]) {
    if (this.failures > 0) {
      this.failures--
      throw new Error('redis down')
    }
    this.entries.push({ stream: String(args[0]), args: args.slice(1) })
    return `${this.entries.length}-0`
  }
  events(): WaEvent[] {
    return this.entries.map((e) => JSON.parse(String(e.args[e.args.length - 1])) as WaEvent)
  }
}

function setup(opts: { retryMs?: number } = {}) {
  const manager = new EventEmitter()
  const queueEmitter = new EventEmitter()
  const views = new Map<string, { transportMessageId: string | null; lastError: string | null }>()
  const queue: OutboxQueue = {
    on: (e, cb) => queueEmitter.on(e, cb),
    off: (e, cb) => queueEmitter.off(e, cb),
    get: async (id) => views.get(id) ?? { transportMessageId: null, lastError: null },
  }
  const redis = new FakeRedis()
  const outbox = attachEventOutbox(manager as unknown as OutboxManager, queue, redis, {
    stream: 'test:wsm:events',
    now: () => AT,
    qrDataUrl: async (qr) => `data:image/png;base64,${Buffer.from(qr).toString('base64')}`,
    ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
  })
  return { manager, queueEmitter, views, redis, outbox }
}

describe('attachEventOutbox (A1)', () => {
  it('XADD <stream> MAXLEN ~ 100000 * event <json> com os eventos de sessão no formato WaEvent v1', async () => {
    const { manager, redis, outbox } = setup()
    const transport = new FakeTransport()
    manager.emit('state', { sessionId: 's1', from: 'NEW', to: 'WARMING' })
    manager.emit('qr', { sessionId: 's1', qr: 'QR1' })
    manager.emit('pairing-code', { sessionId: 's1', code: 'ABCD-1234' })
    manager.emit('connected', { sessionId: 's1', transport, state: 'WARMING' })
    manager.emit('disconnected', { sessionId: 's1', reason: 'forbidden', statusCode: 403 })
    manager.emit('disconnected', { sessionId: 's1', reason: 'local' })
    await outbox.flush()

    expect(redis.entries[0]).toEqual({ stream: 'test:wsm:events', args: ['MAXLEN', '~', 100_000, '*', OUTBOX_EVENT_FIELD, expect.any(String)] })
    const env = { v: 1, session_id: 's1', at: AT.toISOString() }
    expect(redis.events()).toEqual([
      { ...env, type: 'session.state', from: 'NEW', to: 'WARMING' },
      { ...env, type: 'session.qr', qr: `data:image/png;base64,${Buffer.from('QR1').toString('base64')}` },
      { ...env, type: 'session.pairing_code', code: 'ABCD-1234' },
      { ...env, type: 'session.connection', state: 'open' },
      { ...env, type: 'session.connection', state: 'close', reason: 'forbidden', status_code: 403 },
      { ...env, type: 'session.connection', state: 'close' },
    ])
  })

  it('message.inbound em snake_case (com mídia pending, citada e anúncio) a partir do transporte conectado', async () => {
    const { manager, redis, outbox } = setup()
    const transport = new FakeTransport()
    manager.emit('connected', { sessionId: 's1', transport, state: 'WARMING' })
    transport.receive({
      id: 'WA1',
      from: '5511988887777@s.whatsapp.net',
      fromAlt: '123@lid',
      pushName: 'Ana',
      text: 'oi',
      timestamp: 1_700_000_000_000,
      type: 'imageMessage',
      media: { kind: 'image', mime: 'image/jpeg', size: 10, sha256: 'ab', fileName: 'f.jpg' },
      quotedId: 'WA0',
      ad: { ctwaClid: 'c1', sourceId: 'ad1', sourceUrl: 'https://fb.me/x', title: 'Promo' },
    })
    await outbox.flush()
    const inbound = redis.events().find((e) => e.type === 'message.inbound')
    expect(inbound).toEqual({
      v: 1,
      session_id: 's1',
      at: AT.toISOString(),
      type: 'message.inbound',
      message: {
        id: 'WA1',
        from: '5511988887777@s.whatsapp.net',
        alt_jid: '123@lid',
        from_me: false,
        timestamp: 1_700_000_000_000,
        push_name: 'Ana',
        text: 'oi',
        type: 'imageMessage',
        media: { session_id: 's1', message_id: 'WA1', mime: 'image/jpeg', size: 10, sha256: 'ab', key: null, status: 'pending', file_name: 'f.jpg' },
        quoted_id: 'WA0',
        ad: { ctwa_clid: 'c1', source_id: 'ad1', source_url: 'https://fb.me/x', title: 'Promo' },
      },
    })
  })

  it('message.status com transport_message_id e error (failed)', async () => {
    const { queueEmitter, views, redis, outbox } = setup()
    views.set('m1', { transportMessageId: 'WAOUT', lastError: 'boom' })
    const ev = (to: MessageStatusEvent['to'], from: MessageStatusEvent['from']): MessageStatusEvent => ({ messageId: 'm1', sessionId: 's1', from, to })
    queueEmitter.emit('status', ev('queued', null))
    queueEmitter.emit('status', ev('failed', 'processing'))
    await outbox.flush()
    expect(redis.events()).toEqual([
      { v: 1, session_id: 's1', at: AT.toISOString(), type: 'message.status', message_id: 'm1', transport_message_id: 'WAOUT', status: 'queued' },
      { v: 1, session_id: 's1', at: AT.toISOString(), type: 'message.status', message_id: 'm1', transport_message_id: 'WAOUT', status: 'failed', error: 'boom' },
    ])
  })

  it('Redis fora: guarda no buffer e publica em ordem quando volta', async () => {
    const { manager, redis, outbox } = setup({ retryMs: 5 })
    redis.failures = 2
    manager.emit('state', { sessionId: 's1', from: 'NEW', to: 'WARMING' })
    manager.emit('state', { sessionId: 's1', from: 'WARMING', to: 'PAUSED' })
    await outbox.flush()
    expect(outbox.pending).toBe(0)
    expect(redis.events().map((e) => (e.type === 'session.state' ? e.to : ''))).toEqual(['WARMING', 'PAUSED'])
  })

  it('detach: para de escutar manager, fila e transportes', async () => {
    const { manager, queueEmitter, redis, outbox } = setup()
    const transport = new FakeTransport()
    manager.emit('connected', { sessionId: 's1', transport, state: 'WARMING' })
    await outbox.flush()
    outbox.detach()
    manager.emit('state', { sessionId: 's1', from: 'WARMING', to: 'PAUSED' })
    queueEmitter.emit('status', { messageId: 'm', sessionId: 's1', from: null, to: 'queued' })
    transport.receive({ from: '5511@s.whatsapp.net', text: 'x' })
    await outbox.flush()
    expect(redis.events()).toHaveLength(1)
    expect(manager.listenerCount('state')).toBe(0)
  })

  it('toWaMessage omite campos ausentes', () => {
    expect(toWaMessage('s', { id: 'a', from: 'b@s.whatsapp.net', fromMe: true, timestamp: 1, type: 'conversation' })).toEqual({
      id: 'a',
      from: 'b@s.whatsapp.net',
      from_me: true,
      timestamp: 1,
      type: 'conversation',
    })
  })
})
