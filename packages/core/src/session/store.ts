// Persistência das sessões (tabela sessions + health_events). Nunca expõe credenciais (AC-T05-07).
import { and, desc, eq, sql } from 'drizzle-orm'
import { E164_REGEX, healthEvents, proxies, sessionCredentials, sessions, type Database } from '@wsm/db'
import { isUniqueViolation } from '../proxy/errors'
import {
  insertInlineProxy,
  normalizeInlineProxy,
  type InlineProxyInput,
  type NormalizedInlineProxy,
} from '../proxy/inline'
import { decryptProxyPassword } from '../proxy/service'
import { ProxyUrlError } from '../proxy/url'
import { assertTransition, InvalidTransitionError, type SessionState } from './states'

export type SessionRow = typeof sessions.$inferSelect

export type SessionErrorCode = 'SESSION_NOT_FOUND' | 'PROXY_IN_USE' | 'PROXY_NOT_FOUND' | 'VALIDATION_ERROR'

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    /** Campo inválido (VALIDATION_ERROR), ex.: `proxy.port`. */
    readonly field?: string,
  ) {
    super(message)
    this.name = 'SessionError'
  }
}

/** Visão pública da sessão: somente colunas de `sessions` (nenhum material de credencial). */
export interface SessionView {
  id: string
  name: string
  /** Null até a sessão conectar pela primeira vez (cadastro por QR sem número). */
  phone: string | null
  status: SessionState
  /** Alias de `status`. */
  state: SessionState
  proxyId: string | null
  note: string | null
  requiresRestart: boolean
  warmupStartedAt: string | null
  lastConnectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateSessionInput {
  name: string
  /** Opcional no QR: preenchido com o número da conta ao conectar. Obrigatório para pairing code. */
  phone?: string | null
  proxyId?: string | null
  note?: string | null
  /** T17: proxy informado junto com a sessão (criado e vinculado na mesma transação). Exclusivo com proxyId. */
  proxy?: InlineProxyInput | null
}

/** T17 — edição da sessão. `proxy: null` remove o proxy; ausente mantém. */
export interface UpdateSessionInput {
  name?: string
  note?: string | null
  proxy?: InlineProxyInput | null
}

export interface UpdateSessionResult {
  row: SessionRow
  /** O proxy da sessão mudou (troca ou remoção): requires_restart foi marcado. */
  proxyChanged: boolean
  previousProxyId: string | null
  /** Proxy antigo apagado por ter ficado sem uso. */
  deletedProxyId: string | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    state: row.status,
    proxyId: row.proxyId,
    note: row.note,
    requiresRestart: row.requiresRestart,
    warmupStartedAt: iso(row.warmupStartedAt),
    lastConnectedAt: iso(row.lastConnectedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TransitionResult {
  row: SessionRow
  from: SessionState
  to: SessionState
  changed: boolean
}

export interface TransitionOptions {
  /** Campos extras gravados junto com o estado. */
  set?: Partial<Pick<SessionRow, 'warmupStartedAt' | 'lastConnectedAt' | 'requiresRestart'>>
}

export class SessionStore {
  constructor(readonly db: Database) {}

  async create(input: CreateSessionInput): Promise<SessionRow> {
    const phone = input.phone?.trim() || null
    if (phone !== null && !E164_REGEX.test(phone)) throw new SessionError('VALIDATION_ERROR', 'phone must be E.164 (e.g. +5511999999999)', 'phone')
    if (input.proxy && input.proxyId) throw new SessionError('VALIDATION_ERROR', 'use either proxy or proxyId, not both', 'proxy')
    const inline = input.proxy ? normalizeProxyOrThrow(input.proxy) : undefined
    let proxyId = input.proxyId ?? null
    try {
      return await this.db.transaction(async (tx) => {
        if (inline) {
          // T17: proxy e sessão na mesma transação; qualquer falha desfaz os dois.
          proxyId = (await insertInlineProxy(tx, inline)).id
        } else if (proxyId) {
          const [proxy] = await tx.select({ id: proxies.id }).from(proxies).where(eq(proxies.id, proxyId)).for('update')
          if (!proxy) throw new SessionError('PROXY_NOT_FOUND', `proxy ${proxyId} not found`)
          const [owner] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.proxyId, proxyId))
          if (owner) throw new SessionError('PROXY_IN_USE', `proxy ${proxyId} is already assigned to another session`)
          await tx.update(proxies).set({ lastChangedAt: new Date(), updatedAt: new Date() }).where(eq(proxies.id, proxyId))
        }
        const [row] = await tx
          .insert(sessions)
          .values({ name: input.name, phone, proxyId, note: input.note ?? null, status: 'NEW' })
          .returning()
        return row!
      })
    } catch (err) {
      if (isUniqueViolation(err)) throw new SessionError('PROXY_IN_USE', `proxy ${proxyId} is already assigned to another session`)
      throw err
    }
  }

  async list(): Promise<SessionRow[]> {
    return this.db.select().from(sessions).orderBy(desc(sessions.createdAt))
  }

  async find(id: string): Promise<SessionRow | undefined> {
    if (!UUID_RE.test(id)) return undefined
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id))
    return row
  }

  async get(id: string): Promise<SessionRow> {
    const row = await this.find(id)
    if (!row) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
    return row
  }

  /**
   * T17 (AC-T17-04): edita nome, observação e o proxy da sessão numa transação.
   * Trocar ou remover o proxy marca `requires_restart` (a nova rede só vale após restart, T06) e apaga o proxy
   * antigo, que fica sem uso (o vínculo proxy↔sessão é 1:1). No proxy, `password` ausente mantém a senha atual.
   * Proxy igual ao atual não conta como troca.
   */
  async updateDetails(id: string, input: UpdateSessionInput): Promise<UpdateSessionResult> {
    if (input.name !== undefined && !input.name.trim()) throw new SessionError('VALIDATION_ERROR', 'name must not be empty', 'name')
    const inline = input.proxy ? normalizeProxyOrThrow(input.proxy) : input.proxy
    const keepPassword = input.proxy ? input.proxy.password === undefined : false
    if (!UUID_RE.test(id)) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update')
      if (!current) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
      const set: Partial<typeof sessions.$inferInsert> = { updatedAt: new Date() }
      if (input.name !== undefined) set.name = input.name.trim()
      if (input.note !== undefined) set.note = input.note
      const previousProxyId = current.proxyId
      let proxyChanged = false

      if (inline !== undefined) {
        const [old] = previousProxyId ? await tx.select().from(proxies).where(eq(proxies.id, previousProxyId)).for('update') : []
        if (inline === null) {
          proxyChanged = previousProxyId !== null
          set.proxyId = null
        } else {
          const kept = keepPassword && old ? decryptProxyPassword(old) : null
          // Senha só faz sentido com usuário (a URL do proxy é user:pass@host).
          const desired: NormalizedInlineProxy = { ...inline, password: inline.username ? (keepPassword ? kept : inline.password) : null }
          if (!old || !sameProxy(old, desired)) {
            proxyChanged = true
            set.proxyId = (await insertInlineProxy(tx, desired)).id
          }
        }
        if (proxyChanged) set.requiresRestart = true
      }

      const [row] = await tx.update(sessions).set(set).where(eq(sessions.id, id)).returning()
      let deletedProxyId: string | null = null
      if (proxyChanged && previousProxyId) {
        // Vínculo 1:1: o proxy antigo ficou sem uso.
        const [stillUsed] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.proxyId, previousProxyId))
        if (!stillUsed) {
          await tx.delete(proxies).where(eq(proxies.id, previousProxyId))
          deletedProxyId = previousProxyId
        }
      }
      return { row: row!, proxyChanged, previousProxyId, deletedProxyId }
    })
  }

  /**
   * Exclui a sessão. As tabelas dependentes (credenciais, mensagens, eventos, limites, sugestões, vínculos)
   * caem em cascata no banco; o proxy da sessão é apagado se ficar sem uso (vínculo 1:1, como no updateDetails).
   */
  async delete(id: string): Promise<{ deletedProxyId: string | null }> {
    if (!UUID_RE.test(id)) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update')
      if (!current) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
      await tx.delete(sessions).where(eq(sessions.id, id))
      let deletedProxyId: string | null = null
      if (current.proxyId) {
        const [stillUsed] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.proxyId, current.proxyId))
        if (!stillUsed) {
          await tx.delete(proxies).where(eq(proxies.id, current.proxyId))
          deletedProxyId = current.proxyId
        }
      }
      return { deletedProxyId }
    })
  }

  /**
   * Muda o estado validando a SPEC 3.2 contra o valor atual no banco (linha travada).
   * `to === estado atual` é no-op (`changed: false`) quando `allowSame`; senão INVALID_TRANSITION.
   */
  async transition(id: string, to: SessionState, opts: TransitionOptions & { allowSame?: boolean } = {}): Promise<TransitionResult> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(sessions).where(eq(sessions.id, id)).for('update')
      if (!current) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
      const from = current.status
      if (from === to) {
        if (!opts.allowSame) throw new InvalidTransitionError(from, to)
        if (!opts.set) return { row: current, from, to, changed: false }
        const [row] = await tx.update(sessions).set({ ...opts.set, updatedAt: new Date() }).where(eq(sessions.id, id)).returning()
        return { row: row!, from, to, changed: false }
      }
      assertTransition(from, to)
      const [row] = await tx
        .update(sessions)
        .set({ ...opts.set, status: to, updatedAt: new Date() })
        .where(eq(sessions.id, id))
        .returning()
      return { row: row!, from, to, changed: true }
    })
  }

  async update(id: string, set: Partial<Pick<SessionRow, 'warmupStartedAt' | 'lastConnectedAt' | 'requiresRestart' | 'phone'>>): Promise<SessionRow> {
    const [row] = await this.db.update(sessions).set({ ...set, updatedAt: new Date() }).where(eq(sessions.id, id)).returning()
    if (!row) throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
    return row
  }

  async recordHealthEvent(sessionId: string, type: string, detail?: Record<string, unknown>): Promise<void> {
    await this.db.insert(healthEvents).values({ sessionId, type, detail: detail ?? null })
  }

  async hasCredentials(sessionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ one: sql<number>`1` })
      .from(sessionCredentials)
      .where(eq(sessionCredentials.sessionId, sessionId))
      .limit(1)
    return row !== undefined
  }

  /** Sessões a reconectar no boot (AC-T05-04): com credenciais e estado ≠ DISCONNECTED (PAUSED reconecta e segue PAUSED). */
  async listResumable(): Promise<SessionRow[]> {
    const withCreds = sql`exists (select 1 from ${sessionCredentials} where ${sessionCredentials.sessionId} = ${sessions.id})`
    return this.db
      .select()
      .from(sessions)
      .where(and(sql`${sessions.status} <> 'DISCONNECTED'`, withCreds))
      .orderBy(sessions.createdAt)
  }
}

/** Valida o proxy inline; erro de campo vira SessionError VALIDATION_ERROR (400) com o campo. */
function normalizeProxyOrThrow(input: InlineProxyInput): NormalizedInlineProxy {
  try {
    return normalizeInlineProxy(input)
  } catch (err) {
    if (err instanceof ProxyUrlError) throw new SessionError('VALIDATION_ERROR', err.message, (err as ProxyUrlError & { field?: string }).field ?? 'proxy')
    throw err
  }
}

function sameProxy(row: typeof proxies.$inferSelect, p: NormalizedInlineProxy): boolean {
  return (
    row.protocol === p.protocol &&
    row.host === p.host &&
    row.port === p.port &&
    (row.username ?? null) === p.username &&
    (decryptProxyPassword(row) ?? null) === p.password
  )
}
