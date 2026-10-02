// Mensagens recebidas (inbound) e sugestões de resposta com aprovação humana (T13, AC-T13-01/02/06).
// Uma sugestão sempre referencia uma mensagem recebida real (inbound_message_id NOT NULL).
import { and, desc, eq, sql } from 'drizzle-orm'
import { contacts, messages, suggestions, type Database, type SuggestionStatus } from '@wsm/db'
import { jidToE164 } from '../contacts'
import type { MessageRow } from '../queue/store'
import type { SendPipeline } from '../send/pipeline'
import type { IncomingMessage } from '../transport'
import type { AiSuggestion } from './router'

export type SuggestionRow = typeof suggestions.$inferSelect


/** Status gravado nas mensagens recebidas: o enum de mensagens não tem "received"; a direção fica em `direction`. */
export const INBOUND_MESSAGE_STATUS = 'delivered' as const

export interface SuggestionView {
  id: string
  sessionId: string
  inboundMessageId: string
  /** Remetente da mensagem recebida (destinatário da resposta). */
  phone: string
  inboundText: string | null
  intent: string
  confidence: number
  model: string
  text: string
  status: SuggestionStatus
  /** Mensagem enfileirada pelo SendPipeline na aprovação. */
  messageId: string | null
  /** Código do gate que rejeitou o envio (status failed). */
  error: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
  updatedAt: string
}

export type SuggestionErrorCode = 'NOT_FOUND' | 'INVALID_TRANSITION' | 'VALIDATION_ERROR'

export class SuggestionError extends Error {
  constructor(
    readonly code: SuggestionErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SuggestionError'
  }
}

export interface ListSuggestionsFilter {
  sessionId?: string
  status?: SuggestionStatus
  limit?: number
}

export interface ApproveOptions {
  /** Texto editado pelo atendente (default: o sugerido). */
  text?: string
  /** Quem aprovou (autenticado); vai para o gate auth do pipeline e para a auditoria. */
  actor: string
  pipeline: Pick<SendPipeline, 'send'>
}

export interface RecordInboundResult {
  message: MessageRow
  /** false quando a mesma mensagem (msg.id) já tinha sido gravada para a sessão. */
  created: boolean
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const iso = (d: Date | null) => (d ? d.toISOString() : null)

function inboundText(content: unknown): string | null {
  const t = (content as { text?: unknown } | null)?.text
  return typeof t === 'string' ? t : null
}

export function toSuggestionView(row: SuggestionRow, inbound: Pick<MessageRow, 'phone' | 'content'>): SuggestionView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    inboundMessageId: row.inboundMessageId,
    phone: inbound.phone,
    inboundText: inboundText(inbound.content),
    intent: row.intent,
    confidence: row.confidence,
    model: row.model,
    text: row.text,
    status: row.status,
    messageId: row.sentMessageId,
    error: row.error,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export class SuggestionService {
  constructor(readonly db: Database) {}

  /**
   * Persiste a mensagem recebida (direction inbound). Ignora mensagens próprias e remetentes sem telefone
   * (grupos, LIDs): devolve null. A mesma msg.id na mesma sessão não é duplicada.
   */
  async recordInbound(sessionId: string, msg: IncomingMessage): Promise<RecordInboundResult | null> {
    if (msg.fromMe) return null
    const phone = jidToE164(msg.from) ?? jidToE164(msg.fromAlt ?? '')
    if (!phone) return null
    const [existing] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.direction, 'inbound'), eq(messages.transportMessageId, msg.id)))
      .limit(1)
    if (existing) return { message: existing, created: false }
    const [contact] = await this.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.phone, phone)).limit(1)
    const content: Record<string, unknown> = { type: msg.type }
    if (msg.text !== undefined) content.text = msg.text
    if (msg.pushName) content.pushName = msg.pushName
    const at = Number.isFinite(msg.timestamp) && msg.timestamp > 0 ? new Date(msg.timestamp) : new Date()
    const [row] = await this.db
      .insert(messages)
      .values({
        sessionId,
        contactId: contact?.id ?? null,
        direction: 'inbound',
        phone,
        content,
        status: INBOUND_MESSAGE_STATUS,
        transportMessageId: msg.id,
        deliveredAt: at,
      })
      .returning()
    return { message: row!, created: true }
  }

  /** Grava a sugestão como pending_approval. Uma por mensagem recebida (repetição devolve a existente). */
  async create(inbound: MessageRow, suggestion: Pick<AiSuggestion, 'intent' | 'confidence' | 'model' | 'text'>): Promise<SuggestionView> {
    if (inbound.direction !== 'inbound') throw new SuggestionError('VALIDATION_ERROR', 'suggestions require an inbound message')
    const [row] = await this.db
      .insert(suggestions)
      .values({
        sessionId: inbound.sessionId,
        inboundMessageId: inbound.id,
        intent: suggestion.intent,
        confidence: suggestion.confidence,
        model: suggestion.model,
        text: suggestion.text,
        status: 'pending_approval',
      })
      .onConflictDoNothing({ target: suggestions.inboundMessageId })
      .returning()
    if (row) return toSuggestionView(row, inbound)
    const [existing] = await this.db.select().from(suggestions).where(eq(suggestions.inboundMessageId, inbound.id))
    return toSuggestionView(existing!, inbound)
  }

  async list(filter: ListSuggestionsFilter = {}): Promise<SuggestionView[]> {
    const where = []
    if (filter.sessionId) {
      if (!UUID_RE.test(filter.sessionId)) return []
      where.push(eq(suggestions.sessionId, filter.sessionId))
    }
    if (filter.status) where.push(eq(suggestions.status, filter.status))
    const rows = await this.db
      .select({ s: suggestions, phone: messages.phone, content: messages.content })
      .from(suggestions)
      .innerJoin(messages, eq(messages.id, suggestions.inboundMessageId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(suggestions.createdAt))
      .limit(Math.min(Math.max(filter.limit ?? 100, 1), 500))
    return rows.map((r) => toSuggestionView(r.s, r))
  }

  async get(id: string): Promise<SuggestionView> {
    const r = await this.find(id)
    if (!r) throw new SuggestionError('NOT_FOUND', `suggestion ${id} not found`)
    return toSuggestionView(r.s, r)
  }

  /**
   * Aprova e envia pelo SendPipeline (T09). pending_approval → approved → sent (com messageId) ou failed
   * (error = código do gate; a SendRejectedError é relançada). Fora de pending_approval → INVALID_TRANSITION.
   */
  async approve(id: string, opts: ApproveOptions): Promise<SuggestionView> {
    const text = opts.text?.trim()
    if (opts.text !== undefined && !text) throw new SuggestionError('VALIDATION_ERROR', 'text must not be empty')
    const current = await this.find(id)
    if (!current) throw new SuggestionError('NOT_FOUND', `suggestion ${id} not found`)
    const now = new Date()
    const [approved] = await this.db
      .update(suggestions)
      .set({ status: 'approved', text: text ?? current.s.text, decidedBy: opts.actor, decidedAt: now, updatedAt: now })
      .where(and(eq(suggestions.id, id), eq(suggestions.status, 'pending_approval')))
      .returning()
    if (!approved) throw this.invalidTransition(id, 'approved')

    try {
      const message = await opts.pipeline.send({
        sessionId: approved.sessionId,
        phone: current.phone,
        content: { text: approved.text },
        actor: opts.actor,
      })
      const [sent] = await this.db
        .update(suggestions)
        .set({ status: 'sent', sentMessageId: message?.id ?? null, error: null, updatedAt: new Date() })
        .where(eq(suggestions.id, id))
        .returning()
      return toSuggestionView(sent!, current)
    } catch (err) {
      const code = (err as { code?: unknown }).code
      await this.db
        .update(suggestions)
        .set({ status: 'failed', error: typeof code === 'string' ? code : 'INTERNAL_ERROR', updatedAt: new Date() })
        .where(eq(suggestions.id, id))
      throw err
    }
  }

  /** Descarta: pending_approval → rejected. Nada é enviado. */
  async reject(id: string, actor: string): Promise<SuggestionView> {
    const current = await this.find(id)
    if (!current) throw new SuggestionError('NOT_FOUND', `suggestion ${id} not found`)
    const now = new Date()
    const [row] = await this.db
      .update(suggestions)
      .set({ status: 'rejected', decidedBy: actor, decidedAt: now, updatedAt: now })
      .where(and(eq(suggestions.id, id), eq(suggestions.status, 'pending_approval')))
      .returning()
    if (!row) throw this.invalidTransition(id, 'rejected')
    return toSuggestionView(row, current)
  }

  private async find(id: string) {
    if (!UUID_RE.test(id)) return undefined
    const [r] = await this.db
      .select({ s: suggestions, phone: messages.phone, content: messages.content })
      .from(suggestions)
      .innerJoin(messages, eq(messages.id, suggestions.inboundMessageId))
      .where(eq(suggestions.id, id))
    return r
  }

  private invalidTransition(id: string, to: SuggestionStatus): SuggestionError {
    return new SuggestionError('INVALID_TRANSITION', `suggestion ${id} is not pending approval`, { to })
  }

  /** Quantas sugestões existem para uma sessão (útil em métricas/testes). */
  async count(sessionId: string): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(suggestions).where(eq(suggestions.sessionId, sessionId))
    return r?.n ?? 0
  }
}
