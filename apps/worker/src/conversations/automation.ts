import {
  conversationConfigSchema, phoneToUserJid, SENDABLE_STATES, SessionError, splitConversationParts,
  type ConversationConfig, type ConversationModel, type ConversationPending, type ConversationState, type MessageQueue,
  type SendPipeline, type SessionLimitsService, type SessionView,
} from '@wsm/core'
import type { AutomationManager } from '../groups/automation'
import type { ConversationStore } from './store'

const MINUTE = 60_000
const DAY = 86_400_000
const OFFLINE_GRACE = 10 * MINUTE
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
  /** Fonte de aleatoriedade (injetável nos testes). Default: Math.random. */
  random?: () => number
  /** Espera (injetável nos testes). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

/** Tamanho de uma rajada: quantas falas seguidas a mesma conta envia antes de passar a vez. */
const BURST_MIN = 1
const BURST_MAX = 3
/** Uma fala pode sair quebrada em até PARTS_MAX mensagens curtas, cada uma depois de "digitando…". */
const PARTS_MAX = 3
/** Quanto esperar a parte anterior sair antes de desistir das seguintes. */
const PART_SEND_TIMEOUT = 60_000

export class ConversationAutomation {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private stopped = false
  private readonly now: () => number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>
  constructor(private readonly opts: ConversationOptions) {
    this.now = opts.now ?? Date.now; this.random = opts.random ?? Math.random
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }
  /** Sorteia o tamanho da próxima rajada em [BURST_MIN, BURST_MAX]. */
  private burstSize(): number { return BURST_MIN + Math.floor(this.random() * (BURST_MAX - BURST_MIN + 1)) }
  /** Sorteia em quantas mensagens a próxima fala sai: 1 (40%), 2 (40%) ou 3 (20%). */
  private partsCount(): number { const r = this.random(); return r < 0.4 ? 1 : r < 0.8 ? 2 : PARTS_MAX }
  /** "Digitando…" proporcional ao tamanho do texto (1,5 s a ~9 s). Falha de presença não impede o envio. */
  private async typing(senderId: string, phone: string, text: string) {
    await this.opts.manager.getTransport(senderId)?.sendTyping?.(phoneToUserJid(phone), true).catch(() => undefined)
    await this.sleep(Math.min(8_000, Math.max(1_500, 1_200 + text.length * 55)) + Math.floor(this.random() * 800))
  }
  /** Espera a mensagem sair (sentAt) para manter a ordem das partes; false se falhar ou demorar demais. */
  private async waitSent(messageId: string) {
    for (let waited = 0; waited < PART_SEND_TIMEOUT; waited += 1_000) {
      const message = await this.opts.messages.get(messageId)
      if (message.sentAt) return true
      if (['failed', 'cancelled'].includes(message.status)) return false
      await this.sleep(1_000)
    }
    return false
  }
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
    this.running = (async () => { await this.distribute(); if (id) await this.run(id); else await this.tick() })().catch(() => this.opts.logger.warn({}, 'conversation cycle failed'))
      .finally(() => { this.running = undefined })
  }
  private async tick() {
    for (const s of await this.opts.manager.list()) { if (this.stopped) break; await this.run(s.id) }
  }
  /** Prioriza quem está há mais tempo sem par. Só contas habilitadas para rodízio participam. */
  async distribute() {
    if (this.stopped) return
    const lease = await this.opts.store.claim()
    if (!lease) return
    try {
      const sessions = await this.opts.manager.list()
      const states = new Map<string, ConversationState>()
      const configs = new Map<string, ConversationConfig>()
      const occupied = new Set<string>()
      const existing = new Set(sessions.map((s) => s.id))
      for (const s of sessions) {
        const state = await this.opts.store.state(s.id)
        const config = await this.opts.store.config(s.id)
        // Sessão excluída: libera quem estava em par com ela e desativa pares fixos que apontavam para ela.
        const lostPartner = state.partnerId !== undefined && !existing.has(state.partnerId)
        const lostOwner = state.ownerId !== undefined && !existing.has(state.ownerId)
        if (lostPartner || lostOwner) {
          if (lostPartner) {
            delete state.partnerId; delete state.pending; delete state.draft; delete state.halted; delete state.lastError
            state.history = []; state.turns = 0; state.nextSenderId = s.id
          }
          if (lostOwner) delete state.ownerId
          state.nextAt = this.now() + 30 * MINUTE
          if (!await this.opts.store.renew(lease)) return
          await this.opts.store.saveState(s.id, state)
        }
        if (config.mode === 'fixed' && config.targetSessionId && !existing.has(config.targetSessionId)) {
          config.enabled = false; config.targetSessionId = null
          if (!await this.opts.store.renew(lease)) return
          await this.opts.store.saveConfig(s.id, config)
        }
        states.set(s.id, state); configs.set(s.id, config)
        if (state.partnerId) { occupied.add(s.id); occupied.add(state.partnerId) }
        if (state.ownerId) { occupied.add(s.id); occupied.add(state.ownerId) }
        if (state.pending || state.halted) occupied.add(s.id)
        if (config.enabled && config.mode === 'fixed' && config.targetSessionId) {
          occupied.add(s.id); occupied.add(config.targetSessionId)
        }
      }
      // Reconstitui a outra ponta se o processo caiu entre as duas gravações da reserva.
      for (const [ownerId, state] of states) {
        if (!state.partnerId) continue
        const peer = states.get(state.partnerId)
        if (peer && !peer.ownerId) {
          if (!await this.opts.store.renew(lease)) return
          peer.ownerId = ownerId; peer.lastPartnerId = ownerId; peer.lastPairedAt = state.lastPairedAt
          await this.opts.store.saveState(state.partnerId, peer)
        }
      }
      const available: SessionView[] = []
      for (const s of sessions) {
        const state = states.get(s.id)!
        const config = configs.get(s.id)!
        if (!occupied.has(s.id) && config.enabled && config.mode === 'rotating' &&
          (state.nextAt ?? 0) <= this.now() && this.opts.manager.isConnected(s.id) && SENDABLE_STATES.includes(s.status) &&
          await this.hasCapacity(s, config)) available.push(s)
      }
      available.sort((a, b) => (states.get(a.id)!.lastPairedAt ?? 0) - (states.get(b.id)!.lastPairedAt ?? 0) || a.id.localeCompare(b.id))
      while (available.length >= 2) {
        const source = available.shift()!
        const state = states.get(source.id)!
        const different = available.findIndex((s) => s.id !== state.lastPartnerId && states.get(s.id)!.lastPartnerId !== source.id)
        const target = available.splice(different >= 0 ? different : 0, 1)[0]!
        const peer = states.get(target.id)!
        if (!await this.opts.store.renew(lease)) return
        const now = this.now()
        const fresh = { history: [], turns: 0, partnerId: target.id, nextSenderId: source.id,
          lastPartnerId: target.id, lastPairedAt: now } satisfies ConversationState
        // A reserva do dono bloqueia as duas contas mesmo se houver queda antes de salvar a outra ponta.
        await this.opts.store.saveState(source.id, fresh)
        await this.opts.store.saveState(target.id, { ...peer, ownerId: source.id, lastPartnerId: source.id, lastPairedAt: now })
        await this.opts.audit(source.id, { action: 'rotation_pair', targetSessionId: target.id })
      }
    } finally { await this.opts.store.release(lease) }
  }
  /** Sessão excluída: apaga a configuração e o estado dela. Os parceiros são liberados no próximo distribute. */
  async forget(id: string) {
    await this.opts.store.remove(id)
  }
  private async finishRotation(id: string, state: ConversationState, now: number) {
    const partnerId = state.partnerId
    if (!partnerId) return
    const peer = await this.opts.store.state(partnerId)
    delete peer.ownerId
    peer.nextAt = now + 30 * MINUTE
    await this.opts.store.saveState(partnerId, peer)
    delete state.partnerId; delete state.draft; delete state.offlineSince; delete state.burstLeft
    state.history = []; state.turns = 0; state.nextSenderId = id; state.nextAt = now + 30 * MINUTE
    await this.opts.store.saveState(id, state)
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
          const inputAccounts = input.mode === 'rotating' ? [id] : [id, input.targetSessionId]
          const otherAccounts = other.mode === 'rotating' ? [s.id] : [s.id, other.targetSessionId]
          if (other.enabled && inputAccounts.some((v) => otherAccounts.includes(v))) {
            throw new SessionError('VALIDATION_ERROR', 'Uma dessas contas já participa de outro par ativo. Desative esse par primeiro.')
          }
        }
      }
      const previous = await this.opts.store.config(id)
      const state = await this.opts.store.state(id)
      if ((state.partnerId || state.ownerId) && (previous.mode !== input.mode || previous.targetSessionId !== input.targetSessionId)) {
        throw new SessionError('VALIDATION_ERROR', 'Aguarde a rodada terminar antes de trocar o modo ou o par.')
      }
      if (!previous.enabled && input.enabled && state.halted) {
        if (state.pending && !state.pending.messageId) throw new SessionError('VALIDATION_ERROR', 'O envio anterior ficou incerto. Confira o histórico da fila antes de tentar outro par.')
        if (state.pending?.messageId) {
          const message = await this.opts.messages.get(state.pending.messageId)
          if (['queued', 'retrying', 'processing'].includes(message.status)) throw new SessionError('VALIDATION_ERROR', 'A mensagem anterior ainda está na fila. Aguarde ou cancele antes de reativar.')
          state.history = [...state.history, { senderId: state.pending.senderId, text: state.pending.text }].slice(-10)
        }
        delete state.pending; delete state.draft; delete state.halted; delete state.lastError; delete state.burstLeft
        state.turns = 0; state.nextSenderId = id; state.nextAt = this.now() + input.intervalMinutes * MINUTE
        await this.opts.store.saveState(id, state)
      }
      if (previous.targetSessionId !== input.targetSessionId || previous.mode !== input.mode) {
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
    const ownerState = state.ownerId ? await this.opts.store.state(state.ownerId) : state
    const activePartnerId = state.partnerId ?? state.ownerId ?? (config.mode === 'fixed' ? config.targetSessionId : null)
    const accounts = []
    for (const accountId of [id, activePartnerId].filter((v): v is string => Boolean(v))) {
      const limits = await this.opts.limits.get(accountId)
      const used24h = await this.opts.limits.countOutbound(accountId, new Date(this.now() - DAY))
      const ownConfig = config.mode === 'rotating' ? await this.opts.store.config(accountId) : config
      accounts.push({ id: accountId, used24h, dailyLimit: Math.min(ownConfig.maxMessagesPerDay, limits.effective.perDay) })
    }
    const { pending, ...rest } = ownerState
    return { config, activePartnerId, state: { ...rest, pending: pending ? { senderId: pending.senderId, receiverId: pending.receiverId, messageId: pending.messageId, reservedAt: pending.reservedAt } : null }, accounts }
  }
  /** Apenas uma fala esperada deste par é consumida: clientes e outras mensagens continuam na IA assistiva. */
  async handlesInbound(receiverId: string, phone: string, text: string) {
    for (const s of await this.opts.manager.list()) {
      const pending = (await this.opts.store.state(s.id)).pending
      if (pending?.receiverId === receiverId && pending.sourcePhone === phone &&
        (pending.text === text || pending.parts?.some((part) => part.text === text))) return true
    }
    return false
  }
  private async active(id: string, targetId: string) {
    const config = await this.opts.store.config(id)
    const peer = await this.opts.store.config(targetId)
    const matches = config.mode === 'rotating'
      ? (await this.opts.store.state(id)).partnerId === targetId && peer.enabled && peer.mode === 'rotating'
      : config.targetSessionId === targetId
    return !this.stopped && config.enabled && matches &&
      (await Promise.all([id, targetId].map(async (s) => this.opts.manager.isConnected(s) && SENDABLE_STATES.includes((await this.opts.manager.get(s)).status)))).every(Boolean)
  }
  /** O par continua válido (ambas ativas no rodízio, estado de envio) e só falta conexão em alguma das contas. */
  private async onlyDisconnected(id: string, targetId: string) {
    if (this.stopped) return false
    const [config, peer, state] = await Promise.all([this.opts.store.config(id), this.opts.store.config(targetId), this.opts.store.state(id)])
    if (!config.enabled || !peer.enabled || peer.mode !== 'rotating' || state.partnerId !== targetId) return false
    try {
      const sessions = await Promise.all([id, targetId].map((s) => this.opts.manager.get(s)))
      return sessions.every((s) => SENDABLE_STATES.includes(s.status)) && sessions.some((s) => !this.opts.manager.isConnected(s.id))
    } catch { return false }
  }
  private async hasCapacity(account: SessionView, config: ConversationConfig) {
    // Sem número (sessão ainda não conectou pela primeira vez) não há como conversar.
    if (!account.phone || !await this.opts.allowed(account.phone)) return false
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
      const state = await this.opts.store.state(id)
      if (state.ownerId) return
      const targetId = config.mode === 'rotating' ? state.partnerId : config.targetSessionId
      if (!targetId) return
      const isActive = await this.active(id, targetId)
      if (!isActive && !state.pending) {
        if (config.mode === 'rotating' && !state.halted) {
          // Queda momentânea (restart do worker, reconexão): o par espera até 10 min antes de ser desfeito.
          const now = this.now()
          if (await this.onlyDisconnected(id, targetId) && now - (state.offlineSince ??= now) < OFFLINE_GRACE) {
            await this.opts.store.saveState(id, state)
            return
          }
          await this.finishRotation(id, state, now)
        }
        return
      }
      if (state.offlineSince !== undefined) {
        delete state.offlineSince
        await this.opts.store.saveState(id, state)
      }
      const peerConfig = config.mode === 'rotating' ? await this.opts.store.config(targetId) : config
      const interval = Math.max(config.intervalMinutes, peerConfig.intervalMinutes)
      const turnsPerRound = Math.min(config.turnsPerConversation, peerConfig.turnsPerConversation)
      if (state.halted) return
      const now = this.now()
      if (state.pending) {
        const pending = state.pending
        if (!pending.messageId) { state.halted = true; state.lastError = 'Envio com resultado incerto: conversa interrompida para evitar duplicação.' }
        else {
          // Fala em partes: todas precisam ter saído e chegado. Pendências antigas têm uma parte só.
          const parts = pending.parts?.length ? pending.parts : [{ text: pending.text, messageId: pending.messageId }]
          const sent = parts.every((part) => part.messageId) ? await Promise.all(parts.map((part) => this.opts.messages.get(part.messageId!))) : undefined
          const message = sent?.at(-1)
          if (!sent || !message) {
            state.halted = true; state.lastError = 'Envio com resultado incerto: conversa interrompida para evitar duplicação.'
          } else if (sent.some((m) => ['failed', 'cancelled'].includes(m.status))) {
            state.halted = true; state.lastError = 'A mensagem falhou ou foi cancelada. Conversa interrompida.'
          } else if (sent.every((m) => m.sentAt) &&
            (await Promise.all(parts.map((part) => this.opts.received(pending.receiverId, pending.sourcePhone, part.text, pending.reservedAt)))).every(Boolean)) {
            state.history = [...state.history, { senderId: pending.senderId, text: pending.text }].slice(-10)
            state.turns++
            // Rajada: a mesma conta envia um número aleatório de falas antes de passar a vez.
            state.burstLeft = (state.burstLeft ?? this.burstSize()) - 1
            if (state.burstLeft <= 0) {
              state.nextSenderId = pending.receiverId // passa a vez para a outra conta
              state.burstLeft = this.burstSize()      // nova rajada aleatória para ela
            } else {
              state.nextSenderId = pending.senderId   // a mesma conta continua
            }
            state.nextAt = now + interval * MINUTE
            delete state.pending
            delete state.lastError
            if ((state.turns >= turnsPerRound || !isActive) && config.mode === 'rotating') {
              if (!await this.opts.store.renew(lease)) return
              await this.finishRotation(id, state, now)
            } else if (state.turns >= turnsPerRound) {
              state.turns = 0; state.history = []; state.nextSenderId = id; state.nextAt = now + 30 * MINUTE; delete state.burstLeft
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
      if (!await this.hasCapacity(a, config) || !await this.hasCapacity(b, peerConfig)) {
        if (config.mode === 'rotating') await this.finishRotation(id, state, now)
        return
      }
      const sender = state.nextSenderId === targetId ? b : a
      const receiver = sender.id === id ? b : a
      // Uma chamada por intervalo. A fala é reaproveitada se um gate rejeitar o envio.
      state.nextAt = now + interval * MINUTE
      await this.opts.store.saveState(id, state)
      if (!state.draft || state.draft.senderId !== sender.id) {
        const text = await this.opts.model.message(config.topic, sender.id, state.history, this.partsCount())
        if (!await this.opts.store.renew(lease)) return
        state.draft = { senderId: sender.id, text }
        await this.opts.store.saveState(id, state)
      }
      if (!await this.active(id, targetId)) return
      if (!await this.hasCapacity(a, config) || !await this.hasCapacity(b, peerConfig)) return
      if (!sender.phone || !receiver.phone) return
      if (!await this.opts.store.renew(lease)) return
      const texts = splitConversationParts(state.draft.text, PARTS_MAX)
      const pending: ConversationPending = { ...state.draft, text: '', parts: [], receiverId: receiver.id, sourcePhone: sender.phone, reservedAt: this.now() }
      const parts = pending.parts!
      state.pending = pending
      await this.opts.store.saveState(id, state)
      // Cada parte: espera a anterior sair (mantém a ordem), mostra "digitando…" e enfileira. A parte é gravada
      // na pendência antes do envio, para o recebimento ser reconhecido como desta conversa.
      for (const [index, text] of texts.entries()) {
        if (index > 0 && (!await this.waitSent(parts[index - 1]!.messageId!) || !await this.opts.store.renew(lease) || !await this.active(id, targetId))) break
        await this.typing(sender.id, receiver.phone, text)
        parts.push({ text })
        pending.text = parts.map((part) => part.text).join('\n')
        await this.opts.store.saveState(id, state)
        try {
          const message = await this.opts.pipeline.send({ sessionId: sender.id, phone: receiver.phone, content: { text }, actor: 'session-conversations' })
          parts[index]!.messageId = message.id
          pending.messageId = message.id
          delete state.draft
          delete state.lastError
          await this.opts.store.saveState(id, state)
          await this.opts.audit(id, { action: 'turn_queued', senderId: sender.id, receiverId: receiver.id, messageId: message.id, part: index + 1, parts: texts.length })
        } catch (error) {
          const rejected = error instanceof Error && error.name === 'SendRejectedError'
          if (rejected && index > 0) {
            // Gate recusou uma parte seguinte: a fala segue só com as partes que já saíram.
            parts.pop(); pending.text = parts.map((part) => part.text).join('\n')
          } else if (rejected) delete state.pending
          else state.halted = true
          state.lastError = 'Envio rejeitado ou incerto. Verifique os contatos, os limites e a fila.'
          await this.opts.store.saveState(id, state)
          break
        }
      }
    } catch (error) {
      this.opts.logger.warn({ session_id: id, err: error instanceof Error ? error.message : String(error) }, 'conversation turn failed')
      const state = await this.opts.store.state(id)
      state.lastError = 'Falha no ciclo. Verifique a IA, os contatos e a fila.'
      await this.opts.store.saveState(id, state)
    } finally { await this.opts.store.release(lease) }
  }
}
