// Números de autoresposta (próprios do operador): alvos extras das conversas dos chips com proxy, para o volume
// do aquecimento não ficar preso a poucos chips. Guardados como contatos com uma marca de consentimento própria.
import { and, desc, eq, sql } from 'drizzle-orm'
import { contacts, E164_REGEX, messages, type Database } from '@wsm/db'

export const AUTOREPLY_CONSENT_SOURCE = 'autoresposta (número próprio do operador)'

export interface AutoReplyTarget {
  id: string
  phone: string
  createdAt: string
  /** Mensagens dos chips para este número e respostas dele, nas últimas 24 h. */
  sent24h: number
  replies24h: number
  lastSentAt: string | null
}

/** "5511999990000", "+55 (11) 99999-0000" → "+5511999990000"; undefined se não for um número válido. */
export function normalizeAutoReplyPhone(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, '')
  const phone = `+${digits}`
  return E164_REGEX.test(phone) ? phone : undefined
}

export class AutoReplyTargets {
  constructor(private readonly db: Database) {}

  async phones(): Promise<string[]> {
    const rows = await this.db.select({ phone: contacts.phone }).from(contacts)
      .where(and(eq(contacts.consentSource, AUTOREPLY_CONSENT_SOURCE), eq(contacts.consent, true), eq(contacts.optOut, false)))
    return rows.map((r) => r.phone)
  }

  async isTarget(phone: string): Promise<boolean> {
    const [row] = await this.db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.phone, phone), eq(contacts.consentSource, AUTOREPLY_CONSENT_SOURCE)))
    return Boolean(row)
  }

  async list(now: Date = new Date()): Promise<AutoReplyTarget[]> {
    const since = new Date(now.getTime() - 86_400_000)
    const rows = await this.db.select({
      id: contacts.id, phone: contacts.phone, createdAt: contacts.createdAt,
      sent24h: sql<number>`(select count(*) from ${messages} m where m.phone = ${contacts.phone} and m.direction = 'outbound' and m.status in ('sent','delivered','read') and m.created_at > ${since})`,
      replies24h: sql<number>`(select count(*) from ${messages} m where m.phone = ${contacts.phone} and m.direction = 'inbound' and m.created_at > ${since})`,
      lastSentAt: sql<Date | null>`(select max(m.created_at) from ${messages} m where m.phone = ${contacts.phone} and m.direction = 'outbound')`,
    }).from(contacts).where(eq(contacts.consentSource, AUTOREPLY_CONSENT_SOURCE)).orderBy(desc(contacts.createdAt))
    return rows.map((r) => ({
      id: r.id, phone: r.phone, createdAt: r.createdAt.toISOString(),
      sent24h: Number(r.sent24h), replies24h: Number(r.replies24h),
      lastSentAt: r.lastSentAt ? new Date(r.lastSentAt).toISOString() : null,
    }))
  }

  /** Adiciona (ou marca um contato existente). Devolve os inválidos para o painel avisar. */
  async add(raw: string[]): Promise<{ added: string[]; invalid: string[] }> {
    const added: string[] = []
    const invalid: string[] = []
    for (const item of raw.map((r) => r.trim()).filter(Boolean)) {
      const phone = normalizeAutoReplyPhone(item)
      if (!phone) { invalid.push(item); continue }
      const now = new Date()
      await this.db.insert(contacts)
        .values({ phone, name: 'autoresposta', consent: true, consentAt: now, consentSource: AUTOREPLY_CONSENT_SOURCE })
        .onConflictDoUpdate({ target: contacts.phone, set: { consent: true, consentAt: now, consentSource: AUTOREPLY_CONSENT_SOURCE, optOut: false, updatedAt: now } })
      added.push(phone)
    }
    return { added: [...new Set(added)], invalid }
  }

  /** Últimas falas entre o chip e o número (mais antiga primeiro), para a IA continuar o assunto. */
  async history(sessionId: string, phone: string, limit = 8): Promise<Array<{ fromChip: boolean; text: string }>> {
    const rows = await this.db.select({ direction: messages.direction, content: messages.content }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.phone, phone))).orderBy(desc(messages.createdAt)).limit(limit)
    return rows.reverse()
      .map((r) => ({ fromChip: r.direction === 'outbound', text: String((r.content as { text?: unknown })?.text ?? '') }))
      .filter((t) => t.text)
  }

  /** Quando o chip mandou pela última vez para cada número (ms). */
  async lastSentByPhone(sessionId: string): Promise<Map<string, number>> {
    const rows = await this.db.select({ phone: messages.phone, at: sql<Date>`max(${messages.createdAt})` }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.direction, 'outbound'))).groupBy(messages.phone)
    return new Map(rows.map((r) => [r.phone, new Date(r.at).getTime()]))
  }

  /** Remove da lista (o contato é apagado; o histórico de mensagens fica). */
  async remove(id: string): Promise<boolean> {
    const rows = await this.db.delete(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.consentSource, AUTOREPLY_CONSENT_SOURCE))).returning({ id: contacts.id })
    return rows.length > 0
  }
}
