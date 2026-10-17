// Persistência de contatos (T07). Regra central: opt-out só é revertido por ação manual com novo consentimento.
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { auditLogs, contacts, type Database } from '@wsm/db'
import { parseContactsCsv, type ImportRejected } from './csv'
import { isE164 } from './policy'

export type Contact = typeof contacts.$inferSelect

/** Formato público (API): snake_case, datas em ISO 8601. */
export interface ContactDto {
  id: string
  name: string | null
  phone: string
  consent: boolean
  consent_at: string | null
  consent_source: string | null
  opt_out: boolean
  last_contact_at: string | null
  created_at: string
  updated_at: string
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toContactDto(c: Contact): ContactDto {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    consent: c.consent,
    consent_at: iso(c.consentAt),
    consent_source: c.consentSource,
    opt_out: c.optOut,
    last_contact_at: iso(c.lastContactAt),
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  }
}

export type ContactErrorCode = 'not_found' | 'duplicate_phone' | 'invalid_phone' | 'consent_required'

export class ContactError extends Error {
  constructor(
    readonly code: ContactErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ContactError'
  }
}

export interface ContactInput {
  name?: string | null
  phone: string
  consent?: boolean
  consentAt?: Date | null
  consentSource?: string | null
  optOut?: boolean
  lastContactAt?: Date | null
}

export type ContactPatch = Partial<ContactInput>

export interface ListContactsQuery {
  phone?: string
  optOut?: boolean
  consent?: boolean
  limit?: number
  offset?: number
}

export interface ImportResult {
  imported: number
  created: Contact[]
  rejected: ImportRejected[]
}

export interface OptOutResult {
  contact: Contact
  /** `false` se o contato já estava com opt-out. */
  changed: boolean
  /** `true` se o contato não existia e foi criado já com opt-out. */
  created: boolean
}

export interface OptOutContext {
  keyword: string
  sessionId?: string
  messageId?: string
  actor?: string
  /** Origem gravada na auditoria. Default `inbound_message`. */
  source?: string
}

/** Origens de consentimento aceitas da integração CRM (A7). */
export const CONSENT_SOURCES = ['inbound', 'manual', 'import', 'webhook', 'sale'] as const
export type ConsentSource = (typeof CONSENT_SOURCES)[number]

export interface RecordConsentInput {
  phone: string
  source: ConsentSource
  actor?: string
  name?: string | null
}

const UNIQUE_VIOLATION = '23505'

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code === UNIQUE_VIOLATION || e?.cause?.code === UNIQUE_VIOLATION
}

function assertPhone(phone: string) {
  if (!isE164(phone)) throw new ContactError('invalid_phone', 'phone must be E.164 (e.g. +5511999999999)')
}

export class ContactsService {
  constructor(private readonly db: Database) {}

  async list(q: ListContactsQuery = {}): Promise<Contact[]> {
    const where: SQL[] = []
    if (q.phone) where.push(eq(contacts.phone, q.phone))
    if (q.optOut !== undefined) where.push(eq(contacts.optOut, q.optOut))
    if (q.consent !== undefined) where.push(eq(contacts.consent, q.consent))
    return this.db
      .select()
      .from(contacts)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(contacts.createdAt), asc(contacts.id))
      .limit(q.limit ?? 1000)
      .offset(q.offset ?? 0)
  }

  async get(id: string): Promise<Contact | undefined> {
    const [row] = await this.db.select().from(contacts).where(eq(contacts.id, id))
    return row
  }

  async getOrThrow(id: string): Promise<Contact> {
    const row = await this.get(id)
    if (!row) throw new ContactError('not_found', 'contact not found')
    return row
  }

  async findByPhone(phone: string): Promise<Contact | undefined> {
    const [row] = await this.db.select().from(contacts).where(eq(contacts.phone, phone))
    return row
  }

  async create(input: ContactInput): Promise<Contact> {
    assertPhone(input.phone)
    const consent = input.consent ?? false
    try {
      const [row] = await this.db
        .insert(contacts)
        .values({
          name: input.name ?? null,
          phone: input.phone,
          consent,
          // Consentimento sem data explícita é registrado agora.
          consentAt: input.consentAt ?? (consent ? new Date() : null),
          consentSource: input.consentSource ?? null,
          optOut: input.optOut ?? false,
          lastContactAt: input.lastContactAt ?? null,
        })
        .returning()
      return row!
    } catch (err) {
      if (isUniqueViolation(err)) throw new ContactError('duplicate_phone', 'a contact with this phone already exists')
      throw err
    }
  }

  /**
   * Atualização parcial. Reverter opt-out (`optOut: false` num contato com opt-out) exige novo
   * consentimento completo no mesmo patch: `consent: true`, `consentAt` e `consentSource` (AC-T07-05).
   */
  async update(id: string, patch: ContactPatch): Promise<{ contact: Contact; optOutReverted: boolean }> {
    const current = await this.getOrThrow(id)
    if (patch.phone !== undefined) assertPhone(patch.phone)
    const optOutReverted = current.optOut && patch.optOut === false
    if (optOutReverted && !(patch.consent === true && patch.consentAt && patch.consentSource)) {
      throw new ContactError(
        'consent_required',
        'reverting opt-out requires a new consent record: consent=true, consent_at and consent_source',
      )
    }
    const values: Partial<typeof contacts.$inferInsert> = { updatedAt: new Date() }
    if (patch.name !== undefined) values.name = patch.name
    if (patch.phone !== undefined) values.phone = patch.phone
    if (patch.consent !== undefined) values.consent = patch.consent
    if (patch.consentAt !== undefined) values.consentAt = patch.consentAt
    if (patch.consentSource !== undefined) values.consentSource = patch.consentSource
    if (patch.optOut !== undefined) values.optOut = patch.optOut
    if (patch.lastContactAt !== undefined) values.lastContactAt = patch.lastContactAt
    try {
      const [row] = await this.db.update(contacts).set(values).where(eq(contacts.id, id)).returning()
      if (!row) throw new ContactError('not_found', 'contact not found')
      return { contact: row, optOutReverted }
    } catch (err) {
      if (isUniqueViolation(err)) throw new ContactError('duplicate_phone', 'a contact with this phone already exists')
      throw err
    }
  }

  async delete(id: string): Promise<void> {
    const rows = await this.db.delete(contacts).where(eq(contacts.id, id)).returning({ id: contacts.id })
    if (!rows.length) throw new ContactError('not_found', 'contact not found')
  }

  /** Importa um CSV: só linhas com consentimento completo e telefone ainda não cadastrado. */
  async importCsv(text: string): Promise<ImportResult> {
    const { accepted, rejected } = parseContactsCsv(text)
    const created: Contact[] = []
    if (accepted.length) {
      const existing = await this.db
        .select({ phone: contacts.phone })
        .from(contacts)
        .where(inArray(contacts.phone, accepted.map((r) => r.phone)))
      const taken = new Set(existing.map((r) => r.phone))
      for (const row of accepted) {
        if (taken.has(row.phone)) {
          rejected.push({ line: row.line, phone: row.phone, reason: 'phone_already_exists', message: 'a contact with this phone already exists' })
          continue
        }
        const { line, ...values } = row
        const [inserted] = await this.db.insert(contacts).values(values).onConflictDoNothing().returning()
        if (inserted) created.push(inserted)
        else rejected.push({ line, phone: row.phone, reason: 'phone_already_exists', message: 'a contact with this phone already exists' })
      }
    }
    rejected.sort((a, b) => a.line - b.line)
    return { imported: created.length, created, rejected }
  }

  /**
   * A7 (integração CRM): registra consentimento (cria o contato se não existir). NÃO reverte opt-out, exceto com
   * `source: 'manual'` (ação explícita de um usuário, com novo consentimento: a regra do AC-T07-05).
   * Grava `audit_logs` (`contact.consent`) na mesma transação.
   */
  async recordConsent(input: RecordConsentInput): Promise<Contact> {
    assertPhone(input.phone)
    if (!(CONSENT_SOURCES as readonly string[]).includes(input.source)) {
      throw new ContactError('consent_required', `invalid consent source: ${String(input.source)}`)
    }
    const at = new Date()
    const name = input.name?.trim() || null
    return this.db.transaction(async (tx) => {
      const set: Partial<typeof contacts.$inferInsert> = { consent: true, consentAt: at, consentSource: input.source, updatedAt: at }
      if (input.source === 'manual') set.optOut = false
      const [row] = await tx
        .insert(contacts)
        .values({ phone: input.phone, name, consent: true, consentAt: at, consentSource: input.source })
        .onConflictDoUpdate({ target: contacts.phone, set: name ? { ...set, name: sql`coalesce(${contacts.name}, ${name})` } : set })
        .returning()
      await tx.insert(auditLogs).values({
        actor: input.actor ?? 'crm',
        action: 'contact.consent',
        targetType: 'contact',
        targetId: row!.id,
        detail: { phone: input.phone, source: input.source, via: 'crm' },
      })
      return row!
    })
  }

  /**
   * Opt-out pedido pelo próprio contato (mensagem recebida). Nunca reverte nada: só marca `opt_out=true`.
   * Contato desconhecido é criado já com opt-out (sem consentimento), para que o pedido fique registrado.
   * Grava `audit_logs` (`contact.opt_out`, target `contact`) na mesma transação.
   */
  async recordOptOut(phone: string, ctx: OptOutContext): Promise<OptOutResult> {
    assertPhone(phone)
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(contacts).where(eq(contacts.phone, phone)).for('update')
      let contact: Contact
      let created = false
      if (!existing) {
        const [row] = await tx
          .insert(contacts)
          .values({ phone, optOut: true, consent: false })
          .onConflictDoUpdate({ target: contacts.phone, set: { optOut: true, updatedAt: sql`now()` } })
          .returning()
        contact = row!
        created = true
      } else if (existing.optOut) {
        return { contact: existing, changed: false, created: false }
      } else {
        const [row] = await tx
          .update(contacts)
          .set({ optOut: true, updatedAt: new Date() })
          .where(eq(contacts.id, existing.id))
          .returning()
        contact = row!
      }
      await tx.insert(auditLogs).values({
        actor: ctx.actor ?? 'contact',
        action: 'contact.opt_out',
        targetType: 'contact',
        targetId: contact.id,
        detail: {
          phone,
          keyword: ctx.keyword,
          source: ctx.source ?? 'inbound_message',
          created,
          ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
          ...(ctx.messageId ? { message_id: ctx.messageId } : {}),
        },
      })
      return { contact, changed: true, created }
    })
  }
}
