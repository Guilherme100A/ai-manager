// T13 — IA assistiva no worker. Único gatilho: o evento `message` do transporte (mensagem recebida real, AC-T13-06).
// Para cada mensagem recebida: persiste (direction inbound) → opt-out do T07 → classifica e grava a sugestão
// como pending_approval. Vínculos explicitamente habilitados podem antes enfileirar uma resposta fixa
// pelo SessionRouter → SendPipeline; sugestões de IA continuam exigindo aprovação humana.
import { EventEmitter } from 'node:events'
import {
  AiAssistant,
  logger as coreLogger,
  SuggestionService,
  type IncomingMessage,
  type SuggestionView,
  type WaTransport,
  type RouteEvent,
} from '@wsm/core'
import type { Database } from '@wsm/db'
import { createOptOutHandler, type OptOutHandlerResult } from '../optout'

/** Parte do SessionManager (T05) usada aqui. */
export interface AiSessionSource {
  on(event: 'connected', cb: (ctx: { sessionId: string; transport: WaTransport }) => void): unknown
  off(event: 'connected', cb: (ctx: { sessionId: string; transport: WaTransport }) => void): unknown
  list?(): Promise<Array<{ id: string }>>
  getTransport?(sessionId: string): WaTransport | undefined
  isConnected?(sessionId: string): boolean
}

export interface AiLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface AttachAiOptions {
  db: Database
  assistant: AiAssistant
  logger?: AiLogger
  /** Palavras de opt-out (default do T07). */
  optOutKeywords?: readonly string[]
  /** Central routing after persistence and opt-out, before optional AI suggestions. */
  routeIncoming?: (event: RouteEvent) => Promise<number>
}

export type InboundOutcome =
  | { kind: 'ignored'; reason: 'from_me' | 'no_phone' | 'stopped' }
  | { kind: 'duplicate'; messageId: string }
  | { kind: 'opt_out'; messageId: string }
  | { kind: 'no_text'; messageId: string }
  | { kind: 'routed'; messageId: string; queued: number }
  | { kind: 'suggested'; messageId: string; suggestion: SuggestionView }
  | { kind: 'error'; error: string }

export interface AiAttachmentEvents {
  inbound: [{ sessionId: string; messageId: string }]
  suggestion: [SuggestionView]
  opt_out: [{ sessionId: string; messageId: string; phone: string }]
  processed: [{ sessionId: string; outcome: InboundOutcome }]
}

export class AiAttachment extends EventEmitter<AiAttachmentEvents> {
  readonly suggestions: SuggestionService
  private readonly wired = new WeakSet<WaTransport>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly optOut = new Map<string, (m: IncomingMessage) => Promise<OptOutHandlerResult>>()
  private readonly log: AiLogger
  private stopped = false

  constructor(
    private readonly manager: AiSessionSource,
    private readonly opts: AttachAiOptions,
  ) {
    super()
    this.suggestions = new SuggestionService(opts.db)
    this.log = opts.logger ?? safeChild() ?? { info() {}, warn() {}, error() {} }
    manager.on('connected', this.onConnected)
  }

  /** Assina também as sessões que já estavam conectadas no momento do attach. */
  async wireConnected(): Promise<void> {
    const m = this.manager
    if (!m.list || !m.getTransport) return
    for (const s of await m.list()) {
      if (m.isConnected && !m.isConnected(s.id)) continue
      const t = m.getTransport(s.id)
      if (t) this.wire(s.id, t)
    }
  }

  /** Para de processar mensagens novas (os listeners do transporte passam a ignorar). */
  stop(): void {
    this.stopped = true
    this.manager.off('connected', this.onConnected)
  }

  /** Resolve quando todas as mensagens recebidas até aqui foram processadas. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  whenIdle(): Promise<void> {
    return this.idle()
  }

  /** Processa uma mensagem recebida da sessão (o listener do transporte chama isto). Nunca lança. */
  handleIncoming(sessionId: string, msg: IncomingMessage): Promise<InboundOutcome> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve()
    const run = prev.then(() => this.process(sessionId, msg))
    const tail = run.catch(() => undefined)
    this.chains.set(sessionId, tail)
    this.pending.add(tail)
    void tail.finally(() => {
      this.pending.delete(tail)
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId)
    })
    return run
  }

  private readonly onConnected = (ctx: { sessionId: string; transport: WaTransport }) => {
    this.wire(ctx.sessionId, ctx.transport)
  }

  private wire(sessionId: string, transport: WaTransport): void {
    if (this.stopped || this.wired.has(transport)) return
    this.wired.add(transport)
    transport.on('message', (msg) => {
      if (this.stopped) return
      void this.handleIncoming(sessionId, msg)
    })
  }

  private async process(sessionId: string, msg: IncomingMessage): Promise<InboundOutcome> {
    let outcome: InboundOutcome
    try {
      outcome = await this.processUnsafe(sessionId, msg)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.log.error({ session_id: sessionId, message_id: msg.id, err: error }, 'inbound processing failed')
      outcome = { kind: 'error', error }
    }
    this.emit('processed', { sessionId, outcome })
    return outcome
  }

  private async processUnsafe(sessionId: string, msg: IncomingMessage): Promise<InboundOutcome> {
    if (this.stopped) return { kind: 'ignored', reason: 'stopped' }
    if (msg.fromMe) return { kind: 'ignored', reason: 'from_me' }

    // (1) Persiste toda mensagem recebida antes de qualquer classificação.
    const recorded = await this.suggestions.recordInbound(sessionId, msg)
    if (!recorded) return { kind: 'ignored', reason: 'no_phone' }
    const inbound = recorded.message
    if (!recorded.created) return { kind: 'duplicate', messageId: inbound.id }
    this.emit('inbound', { sessionId, messageId: inbound.id })

    // (2) Opt-out tem prioridade: se marcou opt-out, não há sugestão.
    const optOut = await this.optOutHandler(sessionId)(msg)
    if (optOut.handled) {
      this.emit('opt_out', { sessionId, messageId: inbound.id, phone: optOut.phone })
      return { kind: 'opt_out', messageId: inbound.id }
    }

    // (3) Regras habilitadas têm prioridade; sem envio roteado, gera sugestão com aprovação humana.
    const text = msg.text?.trim()
    if (!text) return { kind: 'no_text', messageId: inbound.id }
    if (this.opts.routeIncoming) {
      const queued = await this.opts.routeIncoming({ sessionId, inboundId: msg.id, phone: inbound.phone, text })
      if (queued > 0) return { kind: 'routed', messageId: inbound.id, queued }
    }
    const s = await this.opts.assistant.suggest(text)
    const suggestion = await this.suggestions.create(inbound, s)
    this.log.info(
      { session_id: sessionId, suggestion_id: suggestion.id, intent: s.intent, model: s.model, source: s.source },
      'suggestion pending approval',
    )
    this.emit('suggestion', suggestion)
    return { kind: 'suggested', messageId: inbound.id, suggestion }
  }

  private optOutHandler(sessionId: string) {
    let h = this.optOut.get(sessionId)
    if (!h) {
      h = createOptOutHandler({
        db: this.opts.db,
        sessionId,
        logger: this.log,
        ...(this.opts.optOutKeywords ? { keywords: this.opts.optOutKeywords } : {}),
      })
      this.optOut.set(sessionId, h)
    }
    return h
  }
}

/**
 * Liga a IA assistiva ao SessionManager: assina `message` de cada transporte que conecta (e dos já conectados).
 * Devolve o attachment com `stop()` e `idle()`.
 */
export function attachAi(manager: AiSessionSource, opts: AttachAiOptions): AiAttachment {
  const attachment = new AiAttachment(manager, opts)
  const wiring = attachment.wireConnected().catch((err) => {
    ;(opts.logger ?? safeChild())?.warn({ err: err instanceof Error ? err.message : String(err) }, 'ai: wiring connected sessions failed')
  })
  // idle() também espera a assinatura das sessões já conectadas.
  const idle = attachment.idle.bind(attachment)
  attachment.idle = async () => {
    await wiring
    await idle()
  }
  return attachment
}

function safeChild(): AiLogger | undefined {
  try {
    return coreLogger?.child({ component: 'ai' })
  } catch {
    return undefined
  }
}
