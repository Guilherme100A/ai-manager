// Mensagens por chip: enviadas (saíram para o WhatsApp) e recebidas, no total e nas últimas 24 h.
import { sql } from 'drizzle-orm'
import type { Database } from '@wsm/db'

export interface SessionMessageCounts {
  sentTotal: number
  receivedTotal: number
  sent24h: number
  received24h: number
}

const DAY_MS = 86_400_000

export async function messageCountsBySession(db: Database, now: Date = new Date()): Promise<Record<string, SessionMessageCounts>> {
  const since = new Date(now.getTime() - DAY_MS)
  const rows = (await db.execute(sql`
    select session_id,
      count(*) filter (where direction = 'outbound' and status in ('sent', 'delivered', 'read')) as sent_total,
      count(*) filter (where direction = 'inbound') as received_total,
      count(*) filter (where direction = 'outbound' and status in ('sent', 'delivered', 'read') and created_at > ${since}) as sent_24h,
      count(*) filter (where direction = 'inbound' and created_at > ${since}) as received_24h
    from messages group by session_id`)).rows as Array<Record<string, unknown>>
  return Object.fromEntries(rows.map((r) => [String(r.session_id), {
    sentTotal: Number(r.sent_total),
    receivedTotal: Number(r.received_total),
    sent24h: Number(r.sent_24h),
    received24h: Number(r.received_24h),
  }]))
}
