// Histórico de conversas de um chip, só a partir do banco (mensagens já gravadas na fila e no recebimento).
// Nada aqui fala com o WhatsApp: abrir as conversas no painel não gasta envio nem conta nos limites do chip.
import { sql } from 'drizzle-orm'
import type { Database } from '@wsm/db'

export interface ChatSummary {
  phone: string
  /** Nome do chip (se o número for de outra conta) ou do contato; null se desconhecido. */
  name: string | null
  /** O número é de outra conta deste painel (conversa entre chips). */
  isSession: boolean
  total: number
  sent: number
  received: number
  lastAt: string
  lastText: string | null
  lastDirection: 'inbound' | 'outbound'
}

export interface ChatMessage {
  id: string
  direction: 'inbound' | 'outbound'
  status: string
  text: string | null
  /** Tipo do conteúdo quando não é texto (sticker, image, ...). */
  kind: string
  error: string | null
  createdAt: string
  sentAt: string | null
}

const MEDIA_KINDS = ['sticker', 'image', 'video', 'audio', 'document']

/** Texto e tipo de um `content` gravado (saída: OutgoingContent; entrada: { text, type }). */
export function describeContent(content: unknown): { text: string | null; kind: string } {
  const c = (content ?? {}) as Record<string, unknown>
  const caption = typeof c.caption === 'string' && c.caption ? c.caption : null
  const kind = MEDIA_KINDS.find((k) => k in c) ?? (typeof c.text === 'string' ? 'text' : 'other')
  if (kind === 'text') return { text: c.text as string, kind }
  return { text: caption ?? (typeof c.text === 'string' && c.text ? c.text : null), kind }
}

const iso = (v: unknown): string => new Date(v as string | Date).toISOString()

export class ChatHistory {
  constructor(private readonly db: Database) {}

  /** Conversas do chip, da mais recente para a mais antiga. */
  async list(sessionId: string, limit = 200): Promise<ChatSummary[]> {
    const rows = (await this.db.execute(sql`
      with chats as (
        select phone, count(*) as total,
          count(*) filter (where direction = 'outbound') as sent,
          count(*) filter (where direction = 'inbound') as received,
          max(created_at) as last_at
        from messages where session_id = ${sessionId} group by phone
      )
      select c.*, l.content as last_content, l.direction as last_direction,
        s.name as session_name, ct.name as contact_name
      from chats c
      cross join lateral (
        select content, direction from messages m
        where m.session_id = ${sessionId} and m.phone = c.phone order by m.created_at desc limit 1
      ) l
      left join lateral (select name from sessions where phone = c.phone limit 1) s on true
      left join contacts ct on ct.phone = c.phone
      order by c.last_at desc limit ${limit}
    `)).rows as Array<Record<string, unknown>>
    return rows.map((r) => ({
      phone: r.phone as string,
      name: (r.session_name as string | null) ?? (r.contact_name as string | null) ?? null,
      isSession: r.session_name != null,
      total: Number(r.total),
      sent: Number(r.sent),
      received: Number(r.received),
      lastAt: iso(r.last_at),
      lastText: describeContent(r.last_content).text,
      lastDirection: r.last_direction as ChatSummary['lastDirection'],
    }))
  }

  /** Últimas `limit` mensagens com um número, em ordem cronológica. */
  async messages(sessionId: string, phone: string, limit = 200): Promise<ChatMessage[]> {
    const rows = (await this.db.execute(sql`
      select id, direction, status, content, error, created_at, sent_at from messages
      where session_id = ${sessionId} and phone = ${phone}
      order by created_at desc limit ${limit}
    `)).rows as Array<Record<string, unknown>>
    return rows.reverse().map((r) => {
      const { text, kind } = describeContent(r.content)
      return {
        id: r.id as string,
        direction: r.direction as ChatMessage['direction'],
        status: r.status as string,
        text,
        kind,
        error: (r.error as string | null) ?? null,
        createdAt: iso(r.created_at),
        sentAt: r.sent_at ? iso(r.sent_at) : null,
      }
    })
  }
}
