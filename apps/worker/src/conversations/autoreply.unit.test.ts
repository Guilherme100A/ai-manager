import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONVERSATION_CONFIG, type SessionView } from '@wsm/core'
import { AutoReplyAutomation, AUTOREPLY_MIN_GAP_PER_NUMBER } from './autoreply'

const P1 = '+5511999990001'
const P2 = '+5511999990002'
const chip = (id: string, proxyId: string | null): SessionView => ({ id, name: id, phone: `+5531${id.length}0000000`, status: 'WARMING', proxyId } as SessionView)

function setup(over: { last?: Map<string, number>; used?: number; enabled?: boolean } = {}) {
  let now = 10 * 86_400_000
  const send = vi.fn(async (_input: { sessionId: string; phone: string }) => ({ id: `m${send.mock.calls.length}` }))
  const typing = vi.fn(async () => undefined)
  const model = { message: vi.fn(async () => 'opa\nviu o jogo novo?') }
  const svc = new AutoReplyAutomation({
    manager: {
      list: async () => [chip('proxy', 'px-1'), chip('semproxy', null)],
      isConnected: () => true,
      getTransport: () => ({ sendTyping: typing }) as never,
    },
    config: async () => ({ ...DEFAULT_CONVERSATION_CONFIG, enabled: over.enabled ?? true }),
    targets: {
      phones: async () => [P1, P2],
      history: async () => [],
      lastSentByPhone: async () => over.last ?? new Map(),
    },
    limits: {
      get: async () => ({ effective: { perMinute: 10, perHour: 100, perDay: 1000, warmupDailyLimit: 100 } }) as never,
      countOutbound: async () => over.used ?? 0,
    },
    pipeline: { send } as never,
    model,
    audit: vi.fn(async () => undefined),
    logger: { warn: vi.fn() },
    now: () => now,
    random: () => 0.9, // 2 partes
    sleep: async () => undefined,
  })
  return { svc, send, typing, model, advance: (ms: number) => { now += ms } }
}

describe('conversas com números de autoresposta', () => {
  it('só o chip com proxy manda, em até 2 partes com "digitando…"', async () => {
    const s = setup()
    await s.svc.tick()
    expect(s.send).toHaveBeenCalledTimes(2)
    expect(s.send.mock.calls.every(([input]) => input.sessionId === 'proxy')).toBe(true)
    expect(s.typing).toHaveBeenCalled()
  })

  it('escolhe o número há mais tempo sem mensagem e respeita 60 min por número', async () => {
    const now = 10 * 86_400_000
    const s = setup({ last: new Map([[P1, now - AUTOREPLY_MIN_GAP_PER_NUMBER - 1], [P2, now - 5 * 60_000]]) })
    await s.svc.tick()
    expect(new Set(s.send.mock.calls.map(([input]) => input.phone))).toEqual(new Set([P1]))

    const t = setup({ last: new Map([[P1, now - 60_000], [P2, now - 60_000]]) })
    await t.svc.tick()
    expect(t.send).not.toHaveBeenCalled()
  })

  it('sem folga no limite diário (compartilhado com o rodízio) não manda', async () => {
    const s = setup({ used: 50 }) // limite das conversas: metade de 100
    await s.svc.tick()
    expect(s.send).not.toHaveBeenCalled()
    expect(s.model.message).not.toHaveBeenCalled()
  })

  it('conversa desligada no chip não manda; e espera o intervalo antes de mandar de novo', async () => {
    const off = setup({ enabled: false })
    await off.svc.tick()
    expect(off.send).not.toHaveBeenCalled()

    const s = setup()
    await s.svc.tick()
    await s.svc.tick()
    expect(s.send).toHaveBeenCalledTimes(2) // segundo tick ainda dentro do intervalo
    s.advance(10 * 60_000)
    await s.svc.tick()
    expect(s.send).toHaveBeenCalledTimes(4)
  })
})
