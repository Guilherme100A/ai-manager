import { describe, expect, it, vi } from 'vitest'
import { BaileysAntibanAdapter, type AntibanAdapter } from '../antiban/adapter'
import { FakeTransport } from '../transport'
import { AntibanBlockedError, bindTransportSession, createDeliver, defaultSessionIdOf, isForbiddenError } from './deliver'

const TO = '5511999990001@s.whatsapp.net'

function connected(sessionId = 's1') {
  const t = new FakeTransport()
  void t.connect({ sessionId, auth: {} as never })
  t.open()
  return t
}

function spyAdapter(decision = { allowed: true, delayMs: 0 } as { allowed: boolean; delayMs: number; reason?: string }) {
  const calls: string[] = []
  const adapter: AntibanAdapter = {
    mode: 'real',
    beforeSend: vi.fn(async (key: string) => (calls.push(`before:${key}`), decision)),
    afterSend: vi.fn((key: string) => void calls.push(`after:${key}`)),
    afterSendFailed: vi.fn((key: string) => void calls.push(`failed:${key}`)),
    onDelivered: vi.fn(),
    stats: () => ({ before: 0, allowed: 0, blocked: 0, sent: 0, failed: 0 }),
  }
  return { adapter, calls }
}

describe('createDeliver', () => {
  it('beforeSend → espera delayMs → sendMessage → afterSend', async () => {
    const { adapter, calls } = spyAdapter({ allowed: true, delayMs: 2500 })
    const sleeps: number[] = []
    const t = connected()
    const deliver = createDeliver({ antiban: adapter, sleep: async (ms) => void sleeps.push(ms) })
    const res = await deliver(t, TO, { text: 'oi' })
    expect(res.messageId).toBe(t.sent[0]!.messageId)
    expect(sleeps).toEqual([2500])
    expect(calls).toEqual(['before:s1', 'after:s1'])
    expect(adapter.afterSend).toHaveBeenCalledWith('s1', TO, { text: 'oi' }, res.messageId)
  })

  it('bloqueado pelo antiban: não envia e lança ANTIBAN_BLOCKED', async () => {
    const { adapter } = spyAdapter({ allowed: false, delayMs: 0, reason: 'spam' })
    const t = connected()
    const err = await createDeliver({ antiban: adapter })(t, TO, { text: 'oi' }).catch((e) => e)
    expect(err).toBeInstanceOf(AntibanBlockedError)
    expect(err.code).toBe('ANTIBAN_BLOCKED')
    expect(t.sent).toHaveLength(0)
  })

  it('403 no envio → forbidden_403 no Health Monitor e redução de limites; erro relançado', async () => {
    const { adapter, calls } = spyAdapter()
    const t = connected('sess-403')
    t.failNextSend(Object.assign(new Error('forbidden'), { output: { statusCode: 403 } }))
    const health = { recordSignal: vi.fn(async () => undefined) }
    const limits = { reduce: vi.fn(async () => undefined) }
    await expect(createDeliver({ antiban: adapter, health, limits })(t, TO, { text: 'oi' })).rejects.toThrow('forbidden')
    expect(health.recordSignal).toHaveBeenCalledWith('sess-403', 'forbidden_403', expect.objectContaining({ source: 'send' }))
    expect(limits.reduce).toHaveBeenCalledWith('sess-403', 0.5, expect.any(String))
    expect(calls).toEqual(['before:sess-403', 'failed:sess-403'])
  })

  it('erro comum não gera sinal de 403', async () => {
    const { adapter } = spyAdapter()
    const t = connected()
    t.failNextSend(new Error('timeout'))
    const health = { recordSignal: vi.fn() }
    await expect(createDeliver({ antiban: adapter, health })(t, TO, { text: 'oi' })).rejects.toThrow('timeout')
    expect(health.recordSignal).not.toHaveBeenCalled()
  })

  it('modo real com sleep injetado: bloqueio de mensagens idênticas sem esperar de verdade', async () => {
    const sleeps: number[] = []
    const t = connected()
    const deliver = createDeliver({ antiban: new BaileysAntibanAdapter(), sleep: async (ms) => void sleeps.push(ms) })
    for (let i = 0; i < 3; i++) await deliver(t, TO, { text: 'repetida' })
    await expect(deliver(t, TO, { text: 'repetida' })).rejects.toBeInstanceOf(AntibanBlockedError)
    expect(t.sent).toHaveLength(3)
    expect(sleeps).toHaveLength(3)
    expect(sleeps.every((ms) => ms > 0)).toBe(true)
  })

  it('sessão do transporte: registro explícito e lastConnect', () => {
    const t = connected('abc')
    expect(defaultSessionIdOf(t)).toBe('abc')
    bindTransportSession(t, 'xyz')
    expect(defaultSessionIdOf(t)).toBe('xyz')
    expect(defaultSessionIdOf(new FakeTransport())).toBeUndefined()
  })

  it('isForbiddenError', () => {
    expect(isForbiddenError({ statusCode: 403 })).toBe(true)
    expect(isForbiddenError({ data: { statusCode: 403 } })).toBe(true)
    expect(isForbiddenError({ reason: 'forbidden' })).toBe(true)
    expect(isForbiddenError(new Error('x'))).toBe(false)
    expect(isForbiddenError(null)).toBe(false)
  })
})
