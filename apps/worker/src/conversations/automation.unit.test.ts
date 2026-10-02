import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONVERSATION_CONFIG, SendRejectedError, type ConversationConfig, type ConversationState, type SessionView } from '@wsm/core'
import { ConversationAutomation } from './automation'
import type { ConversationStore } from './store'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
function setup() {
  let now = 1_800_000_000_000
  let locked = false
  const config: ConversationConfig = { ...DEFAULT_CONVERSATION_CONFIG, enabled: true, targetSessionId: B, turnsPerConversation: 2 }
  const configs = new Map([[A, config]])
  const states = new Map<string, ConversationState>()
  const store: ConversationStore = {
    config: async (id) => structuredClone(configs.get(id) ?? DEFAULT_CONVERSATION_CONFIG),
    saveConfig: async (id, value) => { configs.set(id, structuredClone(value)) },
    state: async (id) => structuredClone(states.get(id) ?? { history: [], turns: 0 }),
    saveState: async (id, value) => { states.set(id, structuredClone(value)) },
    claim: async () => { if (locked) return undefined; locked = true; return 'lease' },
    renew: vi.fn(async () => true), release: async () => { locked = false },
  }
  const sessions = new Map([A, B, C].map((id, i) => [id, { id, phone: `+551199999000${i}`, status: 'WARMING' } as SessionView]))
  const connected = new Set([A, B, C])
  const limits = {
    get: vi.fn(async (_id: string) => ({ effective: { perMinute: 5, perHour: 100, perDay: 20 } })),
    countOutbound: vi.fn(async (_id: string, _since: Date) => 0),
  }
  const pipeline = { send: vi.fn(async (_input: unknown) => ({ id: 'out' })) }
  const messages = { get: vi.fn(async (_id: string) => ({ status: 'sent', sentAt: new Date(now).toISOString() })) }
  const model = { message: vi.fn(async (_topic: string, _sender: string, _history: unknown) => 'Qual jogo você recomenda?') }
  const received = vi.fn(async (..._args: unknown[]) => false)
  const allowed = vi.fn(async (_phone: string) => true)
  const manager = { list: async () => [...sessions.values()], get: async (id: string) => sessions.get(id)!, isConnected: (id: string) => connected.has(id), getTransport: () => undefined }
  const options = { manager, store, limits: limits as never, pipeline: pipeline as never, messages: messages as never, model, received, allowed, audit: vi.fn(async () => undefined), logger: { warn: vi.fn() }, now: () => now }
  const automation = new ConversationAutomation(options)
  return { automation, options, store, configs, states, config, sessions, connected, limits, pipeline, messages, model, received, allowed, advance: (ms: number) => { now += ms } }
}
describe('conversas entre duas contas', () => {
  it('envia A → B pela fila, aguarda inbound real e só então permite B → A', async () => {
    const s = setup()
    await s.automation.run(A)
    expect(s.pipeline.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: A, phone: s.sessions.get(B)!.phone }))
    await s.automation.run(A)
    expect(s.model.message).toHaveBeenCalledTimes(1)
    expect(s.states.get(A)!.turns).toBe(0)
    s.received.mockResolvedValue(true)
    await s.automation.run(A)
    expect(s.received).toHaveBeenCalledWith(B, s.sessions.get(A)!.phone, 'Qual jogo você recomenda?', expect.any(Number))
    expect(s.states.get(A)!.turns).toBe(1)
    await s.automation.run(A)
    expect(s.pipeline.send).toHaveBeenCalledTimes(1)
    s.advance(5 * 60_000)
    await s.automation.run(A)
    expect(s.pipeline.send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: B, phone: s.sessions.get(A)!.phone }))
    expect(s.model.message).toHaveBeenLastCalledWith(s.config.topic, B, [{ senderId: A, text: 'Qual jogo você recomenda?' }])
  })
  it('encerra a rodada no teto de falas e espera 30 minutos', async () => {
    const s = setup(); s.received.mockResolvedValue(true)
    await s.automation.run(A); await s.automation.run(A)
    s.advance(5 * 60_000); await s.automation.run(A); await s.automation.run(A)
    expect(s.states.get(A)!.turns).toBe(0)
    s.advance(29 * 60_000); await s.automation.run(A)
    expect(s.pipeline.send).toHaveBeenCalledTimes(2)
    s.advance(60_000); await s.automation.run(A)
    expect(s.pipeline.send).toHaveBeenCalledTimes(3)
  })
  it.each(['disabled', 'paused', 'offline', 'no_consent', 'daily_limit', 'minute_limit'])('não chama modelo nem envia quando %s', async (reason) => {
    const s = setup()
    if (reason === 'disabled') s.config.enabled = false
    if (reason === 'paused') s.sessions.get(B)!.status = 'PAUSED'
    if (reason === 'offline') s.connected.delete(B)
    if (reason === 'no_consent') s.allowed.mockResolvedValue(false)
    if (reason === 'daily_limit') s.limits.countOutbound.mockImplementation(async (_id, since) => s.options.now() - since.getTime() === 86_400_000 ? 20 : 0)
    if (reason === 'minute_limit') s.limits.countOutbound.mockResolvedValue(5)
    await s.automation.run(A)
    expect(s.model.message).not.toHaveBeenCalled(); expect(s.pipeline.send).not.toHaveBeenCalled()
  })
  it('não repete um envio após restart e consome somente o inbound esperado', async () => {
    const s = setup(); await s.automation.run(A)
    const restarted = new ConversationAutomation(s.options)
    await restarted.run(A)
    expect(s.pipeline.send).toHaveBeenCalledTimes(1)
    expect(await restarted.handlesInbound(B, s.sessions.get(A)!.phone, 'Qual jogo você recomenda?')).toBe(true)
    expect(await restarted.handlesInbound(B, s.sessions.get(C)!.phone, 'Qual jogo você recomenda?')).toBe(false)
    expect(await restarted.handlesInbound(B, s.sessions.get(A)!.phone, 'outra mensagem')).toBe(false)
  })
  it('reutiliza a fala depois de gate rejeitado sem nova chamada ao modelo', async () => {
    const s = setup(); s.pipeline.send.mockRejectedValueOnce(new SendRejectedError('RATE_LIMIT', 'limit'))
    await s.automation.run(A)
    expect(s.states.get(A)!.pending).toBeUndefined()
    s.advance(5 * 60_000); await s.automation.run(A)
    expect(s.model.message).toHaveBeenCalledTimes(1); expect(s.pipeline.send).toHaveBeenCalledTimes(2)
  })
  it('interrompe se o resultado do envio for incerto', async () => {
    const s = setup(); s.pipeline.send.mockRejectedValueOnce(new Error('lost connection'))
    await s.automation.run(A); s.advance(86_400_000); await s.automation.run(A)
    expect(s.states.get(A)!.halted).toBe(true); expect(s.pipeline.send).toHaveBeenCalledTimes(1)
  })
  it('não envia após perder a reserva nem se desativado durante geração', async () => {
    const s = setup(); vi.mocked(s.store.renew).mockResolvedValue(false)
    await s.automation.run(A); expect(s.pipeline.send).not.toHaveBeenCalled()
    const other = setup(); other.model.message.mockImplementation(async () => { other.config.enabled = false; return 'oi' })
    await other.automation.run(A); expect(other.pipeline.send).not.toHaveBeenCalled()
  })
  it('evita pares sobrepostos e configuração de conta consigo mesma', async () => {
    const s = setup()
    await expect(s.automation.configure(B, { ...s.config, targetSessionId: C })).rejects.toThrow('outro par')
    await expect(s.automation.configure(A, { ...s.config, targetSessionId: A })).rejects.toThrow('outra conta')
  })
  it('duas execuções concorrentes só enfileiram uma fala', async () => {
    const s = setup(); await Promise.all([s.automation.run(A), s.automation.run(A)])
    expect(s.pipeline.send).toHaveBeenCalledTimes(1)
  })
  it('interrompe por falha da fila e por timeout de recebimento', async () => {
    const s = setup(); await s.automation.run(A)
    s.messages.get.mockResolvedValue({ status: 'failed', sentAt: '' }); await s.automation.run(A)
    expect(s.states.get(A)!.halted).toBe(true)
    const timeout = setup(); await timeout.automation.run(A)
    timeout.messages.get.mockResolvedValue({ status: 'sent', sentAt: new Date(timeout.options.now()).toISOString() })
    timeout.advance(2 * 60 * 60_000 + 1); await timeout.automation.run(A)
    expect(timeout.states.get(A)!.halted).toBe(true)
  })
  it('reativa após falha conhecida, mas preserva bloqueio de envio incerto', async () => {
    const s = setup(); await s.automation.run(A)
    s.messages.get.mockResolvedValue({ status: 'failed', sentAt: '' }); await s.automation.run(A)
    await s.automation.configure(A, { ...s.config, enabled: false })
    await s.automation.configure(A, s.config)
    expect(s.states.get(A)!.halted).toBeUndefined(); expect(s.states.get(A)!.pending).toBeUndefined()
    const uncertain = setup(); uncertain.pipeline.send.mockRejectedValueOnce(new Error('connection'))
    await uncertain.automation.run(A)
    // Uma falha depois da reserva sem messageId exige revisão humana, sem novo envio automático.
    await uncertain.automation.configure(A, { ...uncertain.config, enabled: false })
    await expect(uncertain.automation.configure(A, uncertain.config)).rejects.toThrow('incerto')
  })
})
