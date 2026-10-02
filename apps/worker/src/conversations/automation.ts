import {
  conversationConfigSchema, SENDABLE_STATES, SessionError,
  type ConversationConfig, type ConversationModel, type MessageQueue,
  type SendPipeline, type SessionLimitsService, type SessionView,
} from '@wsm/core'
import type { AutomationManager } from '../groups/automation'
import type { ConversationStore } from './store'

const MINUTE = 60_000
const DAY = 86_400_000
export interface ConversationOptions {
  manager: AutomationManager; store: ConversationStore
  limits: Pick<SessionLimitsService, 'get' | 'countOutbound'>
  pipeline: Pick<SendPipeline, 'send'>; messages: Pick<MessageQueue, 'get'>
  model: ConversationModel
  allowed(phone: string): Promise<boolean>
  received(receiverId: string, sourcePhone: string, text: string, since: number): Promise<boolean>
  audit(sourceId: string, detail: Record<string, unknown>): Promise<void>
  logger: { warn(obj: object, message?: string): void }
  now?: () => number
}

export class ConversationAutomation {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private stopped = false
  private readonly now: () => number
  constructor(private readonly opts: ConversationOptions) { this.now = opts.now ?? Date.now }
  start() {
    this.timer = setInterval(() => this.launch(), MINUTE)
    this.timer.unref?.()
    this.launch()
  }
  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.running
  }
  requestTick(id: string) { this.launch(id); return { queued: !this.stopped } }
  private launch(id?: string) {
    if (this.stopped || this.running) return
    this.running = (id ? this.run(id) : this.tick()).catch(() => this.opts.logger.warn({}, 'conversation cycle failed'))
      .finally(() => { this.running = undefined })
  }
  private async tick() {
    for (const s of await this.opts.manager.list()) { if (this.stopped) break; await this.run(s.id) }
  }
  async configure(id: string, input: ConversationConfig) {
    const parsed = conversationConfigSchema.safeParse(input)
    if (!parsed.success || input.targetSessionId === id) throw new SessionError('VALIDATION_ERROR', 'Selecione outra conta e limites válidos.')
    await this.opts.manager.get(id)
    if (input.targetSessionId) await this.opts.manager.get(input.targetSessionId)
    const lease = await this.opts.store.claim()
    if (!lease) throw new SessionError('VALIDATION_ERROR', 'Conversa em processamento. Tente salvar novamente em alguns segundos.')
    try {
      if (input.enabled) {
        for (const s of await this.opts.manager.list()) {
          if (s.id === id) continue
          const other = await this.opts.store.config(s.id)
          if (other.enabled && [s.id, other.targetSessionId].some((v) => v === id || v === input.targetSessionId)) {
            throw new SessionError('VALIDATION_ERROR', 'Uma dessas contas já participa de outro par ativo. Desative esse par primeiro.')
          }
        }
      }
      const previous = await this.opts.store.config(id)
      const state = await this.opts.store.state(id)
      if (!previous.enabled && input.enabled && state.halted) {
        if (state.pending && !state.pending.messageId) throw new SessionError('VALIDATION_ERROR', 'O envio anterior ficou incerto. Confira o histórico da fila antes de tentar outro par.')
        if (state.pending?.messageId) {
          const message = await this.opts.messages.get(state.pending.messageId)
          if (['queued', 'retrying', 'processing'].includes(message.status)) throw new SessionError('VALIDATION_ERROR', 'A mensagem anterior ainda está na fila. Aguarde ou cancele antes de reativar.')
          state.history = [...state.history, { senderId: state.pending.senderId, text: state.pending.text }].slice(-10)
        }
        delete state.pending; delete state.draft; delete state.halted; delete state.lastError
        state.turns = 0; state.nextSenderId = id; state.nextAt = this.now() + input.intervalMinutes * MINUTE
        await this.opts.store.saveState(id, state)
      }
      if (previous.targetSessionId !== input.targetSessionId) {
        if (state.pending) throw new SessionError('VALIDATION_ERROR', 'Há uma mensagem aguardando confirmação. Preserve o par até concluir.')
        await this.opts.store.saveState(id, { history: [], turns: 0 })
      }
      await this.opts.store.saveConfig(id, parsed.data)
    } finally { await this.opts.store.release(lease) }
    return this.view(id)
  }
  async view(id: string) {
    await this.opts.manager.get(id)
    const [config, state] = await Promise.all([this.opts.store.config(id), this.opts.store.state(id)])
    const accounts = []
    for (const accountId of [id, config.targetSessionId].filter((v): v is string => Boolean(v))) {
      const limits = await this.opts.limits.get(accountId)
      const used24h = await this.opts.limits.countOutbound(accountId, new Date(this.now() - DAY))
      accounts.push({ id: accountId, used24h, dailyLimit: Math.min(config.maxMessagesPerDay, limits.effective.perDay) })
    }
    const { pending, ...rest } = state
    return { config, state: { ...rest, pending: pending ? { senderId: pending.senderId, receiverId: pending.receiverId, messageId: pending.messageId, reservedAt: pending.reservedAt } : null }, accounts }
  }
  /** Apenas uma fala esperada deste par é consumida: clientes e outras mensagens continuam na IA assistiva. */
  async handlesInbound(receiverId: string, phone: string, text: string) {
    for (const s of await this.opts.manager.list()) {
      const config = await this.opts.store.config(s.id)
      if (s.id !== receiverId && config.targetSessionId !== receiverId) continue
      const pending = (await this.opts.store.state(s.id)).pending
      if (pending?.receiverId === receiverId && pending.sourcePhone === phone && pending.text === text) return true
    }
    return false
  }
  private async active(id: string, targetId: string) {
    const config = await this.opts.store.config(id)
    return !this.stopped && config.enabled && config.targetSessionId === targetId &&
      (await Promise.all([id, targetId].map(async (s) => this.opts.manager.isConnected(s) && SENDABLE_STATES.includes((await this.opts.manager.get(s)).status)))).every(Boolean)
  }
  private async hasCapacity(account: SessionView, config: ConversationConfig) {
    if (!await this.opts.allowed(account.phone)) return false
    const limits = await this.opts.limits.get(account.id)
    for (const [window, maximum] of [[MINUTE, limits.effective.perMinute], [60 * MINUTE, limits.effective.perHour], [DAY, Math.min(config.maxMessagesPerDay, limits.effective.perDay)]]) {
      if (await this.opts.limits.countOutbound(account.id, new Date(this.now() - window!)) >= maximum!) return false
    }
    return true
  }
  async run(id: string) {
    const lease = await this.opts.store.claim()
    if (!lease) return
    try {
      const config = await this.opts.store.config(id)
      const targetId = config.targetSessionId
      if (!targetId || !await this.active(id, targetId)) return
      const state = await this.opts.store.state(id)
      if (state.halted) return
      const now = this.now()
      if (state.pending) {
        const pending = state.pending
        if (!pending.messageId) { state.halted = true; state.lastError = 'Envio com resultado incerto: conversa interrompida para evitar duplicação.' }
        else {
          const message = await this.opts.messages.get(pending.messageId)
          if (['failed', 'cancelled'].includes(message.status)) {
            state.halted = true; state.lastError = 'A mensagem falhou ou foi cancelada. Conversa interrompida.'
          } else if (message.sentAt && await this.opts.received(pending.receiverId, pending.sourcePhone, pending.text, pending.reservedAt)) {
            state.history = [...state.history, { senderId: pending.senderId, text: pending.text }].slice(-10)
            state.turns++
            state.nextSenderId = pending.receiverId
            state.nextAt = now + config.intervalMinutes * MINUTE
            delete state.pending
            delete state.lastError
            if (state.turns >= config.turnsPerConversation) {
              state.turns = 0; state.history = []; state.nextSenderId = id; state.nextAt = now + 30 * MINUTE
            }
          } else if (now - (message.sentAt ? Date.parse(message.sentAt) : pending.reservedAt) > 2 * 60 * MINUTE) {
            state.halted = true; state.lastError = 'Sem confirmação de recebimento em duas horas. Conversa interrompida.'
          }
        }
        if (!await this.opts.store.renew(lease)) return
        await this.opts.store.saveState(id, state)
        return
      }
      if ((state.nextAt ?? 0) > now) return
      const a = await this.opts.manager.get(id)
      const b = await this.opts.manager.get(targetId)
      if (!await this.hasCapacity(a, config) || !await this.hasCapacity(b, config)) return
      const sender = state.nextSenderId === targetId ? b : a
      const receiver = sender.id === id ? b : a
      // Uma chamada por intervalo. A fala é reaproveitada se um gate rejeitar o envio.
      state.nextAt = now + config.intervalMinutes * MINUTE
      await this.opts.store.saveState(id, state)
      if (!state.draft || state.draft.senderId !== sender.id) {
        state.draft = { senderId: sender.id, text: await this.opts.model.message(config.topic, sender.id, state.history) }
        await this.opts.store.saveState(id, state)
      }
      if (!await this.active(id, targetId)) return
      if (!await this.hasCapacity(a, config) || !await this.hasCapacity(b, config)) return
      if (!await this.opts.store.renew(lease)) return
      state.pending = { ...state.draft, receiverId: receiver.id, sourcePhone: sender.phone, reservedAt: this.now() }
      await this.opts.store.saveState(id, state)
      try {
        const message = await this.opts.pipeline.send({ sessionId: sender.id, phone: receiver.phone, content: { text: state.pending.text }, actor: 'session-conversations' })
        state.pending.messageId = message.id
        delete state.draft
        delete state.lastError
        await this.opts.store.saveState(id, state)
        await this.opts.audit(id, { action: 'turn_queued', senderId: sender.id, receiverId: receiver.id, messageId: message.id })
      } catch (error) {
        if (error instanceof Error && error.name === 'SendRejectedError') delete state.pending
        else state.halted = true
        state.lastError = 'Envio rejeitado ou incerto. Verifique os contatos, os limites e a fila.'
        await this.opts.store.saveState(id, state)
      }
    } catch {
      const state = await this.opts.store.state(id)
      state.lastError = 'Falha no ciclo. Verifique a IA, os contatos e a fila.'
      await this.opts.store.saveState(id, state)
    } finally { await this.opts.store.release(lease) }
  }
}
