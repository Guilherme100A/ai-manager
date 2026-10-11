import { describe, expect, it } from 'vitest'
import { FakeTransport, PassthroughAntibanAdapter, bindTransportSession, type AntibanAdapter } from '@wsm/core'
import { createGuardedDeliver, memoryInflightStore, redisInflightStore, withMarkPoint } from './send-guard'

const TO = '5511999990001@s.whatsapp.net'
const quiet = { warn() {} }

function connected(sessionId: string) {
  const t = new FakeTransport()
  bindTransportSession(t, sessionId)
  t.open()
  return t
}

describe('createGuardedDeliver', () => {
  it('grava a marca depois da espera do antiban e antes do sendMessage; apaga ao terminar', async () => {
    const inflight = memoryInflightStore()
    const t = connected('s1')
    const seen: string[] = []
    const sleeps: number[] = []
    const deliver = createGuardedDeliver({
      antiban: new PassthroughAntibanAdapter(quiet),
      inflight,
      sleep: async (ms) => {
        sleeps.push(ms)
        seen.push(`sleep:${inflight.keys.has('s1')}`)
      },
      delays: { holdBeforeSend: () => 100, sendDelay: () => 50 },
    })
    const origPush = t.sent.push.bind(t.sent)
    ;(t.sent as unknown[]).push = (...items: unknown[]) => {
      seen.push(`send:${inflight.keys.has('s1')}`)
      return origPush(...(items as never[]))
    }
    await deliver(t, TO, { text: 'oi' })
    // delay 0 do passthrough vira 1 ms (ponto da marca) + hold 100; depois da marca, send-delay 50
    expect(sleeps).toEqual([101, 50])
    expect(seen).toEqual(['sleep:false', 'sleep:true', 'send:true'])
    expect(inflight.keys.has('s1')).toBe(false)
  })

  it('falha no envio também apaga a marca; bloqueio do antiban nunca marca', async () => {
    const inflight = memoryInflightStore()
    const t = connected('s2')
    t.failNextSend(new Error('boom'))
    const deliver = createGuardedDeliver({ antiban: new PassthroughAntibanAdapter(quiet), inflight, sleep: async () => {} })
    await expect(deliver(t, TO, { text: 'x' })).rejects.toThrow('boom')
    expect(inflight.keys.size).toBe(0)

    const blocked: AntibanAdapter = {
      mode: 'real',
      beforeSend: async () => ({ allowed: false, delayMs: 0, reason: 'spam' }),
      afterSend() {},
      afterSendFailed() {},
      onDelivered() {},
      stats: () => ({ before: 0, allowed: 0, blocked: 0, sent: 0, failed: 0 }),
    }
    const marks: string[] = []
    const d2 = createGuardedDeliver({ antiban: blocked, inflight: { ...inflight, mark: async (id) => void marks.push(id) }, sleep: async () => {} })
    await expect(d2(t, TO, { text: 'x' })).rejects.toMatchObject({ code: 'ANTIBAN_BLOCKED' })
    expect(marks).toEqual([])
  })

  it('erro ao gravar a marca impede o envio (fail-safe)', async () => {
    const t = connected('s3')
    const inflight = { ...memoryInflightStore(), mark: async () => Promise.reject(new Error('redis down')) }
    const deliver = createGuardedDeliver({ antiban: new PassthroughAntibanAdapter(quiet), inflight, sleep: async () => {} })
    await expect(deliver(t, TO, { text: 'x' })).rejects.toThrow('redis down')
    expect(t.sent).toHaveLength(0)
  })

  it('403 → health.recordSignal com a sessão do transporte', async () => {
    const t = connected('s4')
    t.failNextSend(Object.assign(new Error('forbidden'), { statusCode: 403 }))
    const signals: unknown[][] = []
    const deliver = createGuardedDeliver({
      antiban: new PassthroughAntibanAdapter(quiet),
      inflight: memoryInflightStore(),
      sleep: async () => {},
      health: { recordSignal: async (...a: unknown[]) => void signals.push(a) },
    })
    await expect(deliver(t, TO, { text: 'x' })).rejects.toThrow()
    expect(signals[0]?.slice(0, 2)).toEqual(['s4', 'forbidden_403'])
  })

  it('withMarkPoint garante delay ≥ 1 só quando permitido', async () => {
    const a = withMarkPoint(new PassthroughAntibanAdapter(quiet))
    expect(await a.beforeSend('k', TO, { text: 'x' })).toEqual({ allowed: true, delayMs: 1 })
    expect(a.mode).toBe('passthrough')
  })
})

describe('redisInflightStore', () => {
  it('chaves por sessão com prefixo', async () => {
    const data = new Map<string, string>()
    const redis = {
      set: async (k: string, v: string) => void data.set(k, v),
      del: async (k: string) => void data.delete(k),
      exists: async (k: string) => (data.has(k) ? 1 : 0),
    }
    const store = redisInflightStore(redis, 'p')
    await store.mark('a')
    expect([...data.keys()]).toEqual(['p:send-inflight:a'])
    expect(await store.has('a')).toBe(true)
    await store.clear('a')
    expect(await store.has('a')).toBe(false)
  })
})
