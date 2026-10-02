// Persistência das mensagens (tabelas messages + message_events). Toda transição é atômica com seu evento (SPEC 3.3).
import { and, asc, desc, eq, type SQL } from 'drizzle-orm'
import { E164_REGEX, messageEvents, messages, sessions, type Database } from '@wsm/db'
import type { OutgoingContent } from '../transport'
import { SessionError } from '../session'
import { canTransitionMessage, MessageNotFoundError, MessageTransitionError, type MessageStatus } from './states'

export type MessageRow = typeof messages.$inferSelect
export type MessageEventRow = typeof messageEvents.$inferSelect

export interface MessageView {
  id: string
  sessionId: string
  contactId: string | null
  phone: string
  content: unknown
  status: MessageStatus
  attempts: number
  /** Último erro de envio (coluna `error`). */
  lastError: string | null
  transportMessageId: string | null
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MessageEventView {
  id: number
  messageId: string
  from: MessageStatus | null
  to: MessageStatus
  detail: unknown
  createdAt: string
}

export interface EnqueueMessageInput {
  sessionId: string
  /** Telefone E.164 ou JID de grupo autorizado pelo SendPipeline.sendGroup. */
  phone: string
  content: OutgoingContent
  contactId?: string | null
}

export interface ListMessagesFilter {
  sessionId?: string
  status?: MessageStatus
  limit?: number
}

type MessageSet = Partial<Pick<MessageRow, 'attempts' | 'error' | 'transportMessageId' | 'sentAt' | 'deliveredAt' | 'readAt'>>

export interface MessageTransitionOptions {
  /** Estados de origem aceitos; fora deles `tryTransition` devolve null (e `transition` lança). */
  from?: readonly MessageStatus[]
  set?: MessageSet | ((row: MessageRow) => MessageSet)
  detail?: Record<string, unknown>
}

export interface MessageTransitionResult {
  row: MessageRow
  from: MessageStatus
  to: MessageStatus
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function toMessageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    contactId: row.contactId,
    phone: row.phone,
    content: row.content,
    status: row.status,
    attempts: row.attempts,
    lastError: row.error,
    transportMessageId: row.transportMessageId,
    sentAt: iso(row.sentAt),
    deliveredAt: iso(row.deliveredAt),
    readAt: iso(row.readAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toMessageEventView(row: MessageEventRow): MessageEventView {
  return {
    id: row.id,
    messageId: row.messageId,
    from: row.fromStatus,
    to: row.toStatus,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  }
}

export class MessageStore {
  constructor(readonly db: Database) {}

  /** Grava a mensagem em `queued` junto com o evento inicial (from = null). */
  async create(input: EnqueueMessageInput): Promise<MessageRow> {
    if (!E164_REGEX.test(input.phone) && !/^[^\s@]+@g\.us$/.test(input.phone)) throw new SessionError('VALIDATION_ERROR', 'phone must be E.164 (e.g. +5511999999999)')
    if (input.phone.endsWith('@g.us') && input.contactId) throw new SessionError('VALIDATION_ERROR', 'group messages cannot reference an individual contact')
    if (!isUuid(input.sessionId)) throw new SessionError('SESSION_NOT_FOUND', `session ${input.sessionId} not found`)
    return this.db.transaction(async (tx) => {
      const [session] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, input.sessionId))
      if (!session) throw new SessionError('SESSION_NOT_FOUND', `session ${input.sessionId} not found`)
      const [row] = await tx
        .insert(messages)
        .values({
          sessionId: input.sessionId,
          contactId: input.contactId ?? null,
          phone: input.phone,
          content: input.content,
          status: 'queued',
        })
        .returning()
      await tx.insert(messageEvents).values({ messageId: row!.id, fromStatus: null, toStatus: 'queued' })
      return row!
    })
  }

  async find(id: string): Promise<MessageRow | undefined> {
    if (!isUuid(id)) return undefined
    const [row] = await this.db.select().from(messages).where(eq(messages.id, id))
    return row
  }

  async get(id: string): Promise<MessageRow> {
    const row = await this.find(id)
    if (!row) throw new MessageNotFoundError(id)
    return row
  }

  async list(filter: ListMessagesFilter = {}): Promise<MessageRow[]> {
    const where: SQL[] = []
    if (filter.sessionId) {
      if (!isUuid(filter.sessionId)) return []
      where.push(eq(messages.sessionId, filter.sessionId))
    }
    if (filter.status) where.push(eq(messages.status, filter.status))
    return this.db
      .select()
      .from(messages)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(messages.createdAt))
      .limit(filter.limit ?? 100)
  }

  async events(messageId: string): Promise<MessageEventRow[]> {
    if (!isUuid(messageId)) return []
    return this.db.select().from(messageEvents).where(eq(messageEvents.messageId, messageId)).orderBy(asc(messageEvents.id))
  }

  async findByTransportId(sessionId: string, transportMessageId: string): Promise<MessageRow | undefined> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.transportMessageId, transportMessageId)))
      .limit(1)
    return row
  }

  async sessionStatus(sessionId: string) {
    const [row] = await this.db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, sessionId))
    return row?.status
  }

  /** Transição validada (SPEC 3.3) com linha travada; lança se inválida. */
  async transition(id: string, to: MessageStatus, opts: MessageTransitionOptions = {}): Promise<MessageTransitionResult> {
    const res = await this.apply(id, to, opts, true)
    return res!
  }

  /** Igual a `transition`, mas devolve null se o estado atual não permitir (corridas: cancel × worker, receipts). */
  async tryTransition(id: string, to: MessageStatus, opts: MessageTransitionOptions = {}): Promise<MessageTransitionResult | null> {
    return this.apply(id, to, opts, false)
  }

  /** queued|retrying → cancelled (AC-T08-04). Demais estados → MessageTransitionError. */
  async cancel(id: string, detail?: Record<string, unknown>): Promise<MessageTransitionResult> {
    return this.transition(id, 'cancelled', { from: ['queued', 'retrying'], ...(detail ? { detail } : {}) })
  }

  private async apply(id: string, to: MessageStatus, opts: MessageTransitionOptions, strict: boolean): Promise<MessageTransitionResult | null> {
    if (!isUuid(id)) throw new MessageNotFoundError(id)
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(messages).where(eq(messages.id, id)).for('update')
      if (!current) throw new MessageNotFoundError(id)
      const from = current.status
      const allowed = canTransitionMessage(from, to) && (!opts.from || opts.from.includes(from))
      if (!allowed) {
        if (strict) throw new MessageTransitionError(from, to)
        return null
      }
      const set = typeof opts.set === 'function' ? opts.set(current) : (opts.set ?? {})
      const [row] = await tx
        .update(messages)
        .set({ ...set, status: to, updatedAt: new Date() })
        .where(eq(messages.id, id))
        .returning()
      await tx.insert(messageEvents).values({ messageId: id, fromStatus: from, toStatus: to, detail: opts.detail ?? null })
      return { row: row!, from, to }
    })
  }
}

