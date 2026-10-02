import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONVERSATION_CONFIG, SendRejectedError, type ConversationConfig, type ConversationState, type SessionView } from '@wsm/core'
import { ConversationAutomation } from './automation'
import type { ConversationStore } from './store'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
function setup(over: { random?: () => number } = {}) {
  let now = 1_800_000_000_000
  let locked = false
  const config: ConversationConfig = { ...DEFAULT_CONVERSATION_CONFIG, mode: 'fixed', enabled: true, targetSessionId: B, turnsPerConversation: 2 }
  const configs = new Map([[A, config]])
  const states = new Map<string, ConversationState>()
  const store: ConversationStore = {
    config: async (id) => structuredClone(configs.get(id) ?? DEFAULT_CONVERSATION_CONFIG),
    saveConfig: async (id, value) => { configs.set(id, structuredClone(value)) },
    state: async (id) => structuredClone(states.get(id) ?? { history: [], turns: 0 }),
    saveState: async (id, value) => { states.set(id, structuredClone(value)) },
    remove: async (id) => { configs.delete(id); states.delete(id) },
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
  const options = { manager, store, limits: limits as never, pipeline: pipeline as never, messages: messages as never, model, received, allowed, audit: vi.fn(async () => undefined), logger: { warn: vi.fn() }, now: () => now, random: over.random ?? (() => 0) }
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
    expect(s.received).toHaveBeenCalledWith(B, s.sessions.get(A)!.phone!, 'Qual jogo você recomenda?', expect.any(Number))
    expect(s.states.get(A)!.turns).toBe(1)
    await s.automation.run(A)
    expect(s.pipeline.send).toHaveBeenCalledTimes(1)
    s.advance(5 * 60_000)
    await s.automation.run(A)
    expect(s.pipeline.send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: B, phone: s.sessions.get(A)!.phone }))
    expect(s.model.message).toHaveBeenLastCalledWith(s.config.topic, B, [{ senderId: A, text: 'Qual jogo você recomenda?' }])
  })
  it('rajada: a mesma conta envia várias falas seguidas antes de passar a vez', async () => {
    const s = setup({ random: () => 0.99 }) // burstSize sempre no máximo (3)
    s.configs.set(A, { ...s.config, turnsPerConversation: 6 })
    s.received.mockResolvedValue(true)
    await s.automation.run(A) // fala 1: A → B
    expect(s.pipeline.send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: A, phone: s.sessions.get(B)!.phone }))
    await s.automation.run(A) // confirma fala 1
    expect(s.states.get(A)!.turns).toBe(1)
    s.advance(5 * 60_000)
    await s.automation.run(A) // fala 2: AINDA A → B (rajada), não alternou
    expect(s.pipeline.send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: A, phone: s.sessions.get(B)!.phone }))
    await s.automation.run(A) // confirma fala 2
    expect(s.states.get(A)!.turns).toBe(2)
    expect(s.states.get(A)!.nextSenderId).toBe(A)
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
    expect(await restarted.handlesInbound(B, s.sessions.get(A)!.phone!, 'Qual jogo você recomenda?')).toBe(true)
    expect(await restarted.handlesInbound(B, s.sessions.get(C)!.phone!, 'Qual jogo você recomenda?')).toBe(false)
    expect(await restarted.handlesInbound(B, s.sessions.get(A)!.phone!, 'outra mensagem')).toBe(false)
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
  function rotation(s: ReturnType<typeof setup>, ids = [A, B, C]) {
    for (const id of ids) s.configs.set(id, { ...s.config, mode: 'rotating', targetSessionId: null })
  }
  async function finish(s: ReturnType<typeof setup>, owner: string) {
    s.received.mockResolvedValue(true)
    await s.automation.run(owner); await s.automation.run(owner)
    s.advance(5 * 60_000)
    await s.automation.run(owner); await s.automation.run(owner)
  }
  it('com três contas, quem ficou esperando inicia o próximo par', async () => {
    const s = setup(); rotation(s)
    await s.automation.distribute()
    expect(s.states.get(A)!.partnerId).toBe(B)
    expect(s.states.get(C)?.partnerId).toBeUndefined()
    await finish(s, A)
    await s.automation.distribute()
    expect(s.states.get(C)?.partnerId).toBeUndefined()
    s.advance(30 * 60_000); await s.automation.distribute()
    expect(s.states.get(C)!.partnerId).toBe(A)
    expect(s.states.get(A)!.ownerId).toBe(C)
    expect(s.states.get(B)!.ownerId).toBeUndefined()
  })
  it('com quatro contas, forma dois pares sem sobreposição e troca os parceiros', async () => {
    const s = setup()
    const D = '44444444-4444-4444-8444-444444444444'
    s.sessions.set(D, { id: D, phone: '+5511999990003', status: 'WARMING' } as SessionView); s.connected.add(D)
    rotation(s, [A, B, C, D]); await s.automation.distribute()
    expect(s.states.get(A)!.partnerId).toBe(B); expect(s.states.get(C)!.partnerId).toBe(D)
    await finish(s, A); await finish(s, C)
    s.advance(30 * 60_000); await s.automation.distribute()
    expect(s.states.get(A)!.partnerId).toBe(C); expect(s.states.get(B)!.partnerId).toBe(D)
  })
  it('não troca parceiro nem reenvia enquanto há mensagem pendente, inclusive após restart', async () => {
    const s = setup(); rotation(s); await s.automation.distribute(); await s.automation.run(A)
    const restart = new ConversationAutomation(s.options)
    await restart.distribute(); await restart.run(B)
    expect(s.states.get(A)!.partnerId).toBe(B); expect(s.pipeline.send).toHaveBeenCalledTimes(1)
    expect((await restart.view(B)).activePartnerId).toBe(A)
    expect((await restart.view(B)).state.pending).toMatchObject({ senderId: A, receiverId: B })
  })
  it('permite habilitar várias contas no rodízio e aplica a cota própria do parceiro', async () => {
    const s = setup(); rotation(s)
    await s.automation.configure(B, s.configs.get(B)!)
    s.configs.set(B, { ...s.configs.get(B)!, maxMessagesPerDay: 1 })
    s.limits.countOutbound.mockImplementation(async (id) => id === B ? 1 : 0)
    await s.automation.distribute()
    expect(s.states.get(A)!.partnerId).toBe(C)
    expect(s.states.get(B)?.ownerId).toBeUndefined()
  })
  it('remove desabilitadas/offline da distribuição e preserva pares fixos', async () => {
    const s = setup(); rotation(s); s.connected.delete(B)
    await s.automation.distribute(); expect(s.states.get(A)!.partnerId).toBe(C)
    const fixed = setup(); fixed.configs.set(C, { ...fixed.config, mode: 'rotating', targetSessionId: null })
    await fixed.automation.distribute(); expect(fixed.states.size).toBe(0)
  })
  it('desativar o parceiro não perde confirmação da fala já enviada', async () => {
    const s = setup(); rotation(s); await s.automation.distribute(); await s.automation.run(A)
    s.configs.get(B)!.enabled = false
    await s.automation.distribute(); expect(s.states.get(A)!.partnerId).toBe(B)
    s.received.mockResolvedValue(true); await s.automation.run(A)
    expect(s.states.get(A)!.pending).toBeUndefined(); expect(s.states.get(A)!.partnerId).toBeUndefined()
    expect(s.states.get(B)!.ownerId).toBeUndefined(); expect(s.pipeline.send).toHaveBeenCalledTimes(1)
  })
  it('repara reserva parcialmente gravada sem formar outro par para a mesma conta', async () => {
    const s = setup(); rotation(s)
    s.states.set(A, { history: [], turns: 0, partnerId: B, lastPairedAt: s.options.now() })
    await s.automation.distribute()
    expect(s.states.get(B)!.ownerId).toBe(A)
    expect(s.states.get(C)?.partnerId).toBeUndefined()
    expect((await s.automation.view(B)).activePartnerId).toBe(A)
  })
  it('sessão excluída: libera o parceiro (dono ou convidado) com pausa e apaga o estado dela', async () => {
    const owner = setup(); rotation(owner); await owner.automation.distribute(); await owner.automation.run(A)
    expect(owner.states.get(A)!.pending).toBeDefined()
    owner.sessions.delete(B); owner.connected.delete(B); await owner.automation.forget(B)
    expect(owner.states.has(B)).toBe(false)
    await owner.automation.distribute()
    expect(owner.states.get(A)).toMatchObject({ turns: 0, history: [] })
    expect(owner.states.get(A)!.partnerId).toBeUndefined(); expect(owner.states.get(A)!.pending).toBeUndefined()
    expect(owner.states.get(C)?.partnerId).toBeUndefined()
    owner.advance(30 * 60_000); await owner.automation.distribute()
    // C esperou mais (nunca formou par), então é quem inicia o novo par com A.
    expect(owner.states.get(C)!.partnerId).toBe(A)
    expect(owner.states.get(A)!.ownerId).toBe(C)

    const guest = setup(); rotation(guest); await guest.automation.distribute()
    guest.sessions.delete(A); guest.connected.delete(A); await guest.automation.forget(A)
    await guest.automation.distribute()
    expect(guest.states.get(B)!.ownerId).toBeUndefined()
    guest.advance(30 * 60_000); await guest.automation.distribute()
    expect(guest.states.get(B)!.partnerId ?? guest.states.get(B)!.ownerId).toBe(C)
  })
  it('queda momentânea de conexão não desfaz o par; mais de 10 min desconectado desfaz', async () => {
    const s = setup(); rotation(s); await s.automation.distribute()
    s.connected.delete(B)
    await s.automation.run(A)
    expect(s.states.get(A)!.partnerId).toBe(B)
    s.advance(5 * 60_000); await s.automation.run(A)
    expect(s.states.get(A)!.partnerId).toBe(B)
    s.connected.add(B); await s.automation.run(A)
    expect(s.states.get(A)!.offlineSince).toBeUndefined()
    expect(s.pipeline.send).toHaveBeenCalledTimes(1)

    const gone = setup(); rotation(gone); await gone.automation.distribute()
    gone.connected.delete(B)
    await gone.automation.run(A)
    gone.advance(10 * 60_000); await gone.automation.run(A)
    expect(gone.states.get(A)!.partnerId).toBeUndefined()
    expect(gone.states.get(B)!.ownerId).toBeUndefined()
  })
  it('sessão excluída: desativa par fixo que apontava para ela', async () => {
    const s = setup()
    s.sessions.delete(B); s.connected.delete(B)
    await s.automation.distribute()
    expect(s.configs.get(A)).toMatchObject({ enabled: false, targetSessionId: null })
    await s.automation.run(A)
    expect(s.pipeline.send).not.toHaveBeenCalled()
  })
})
