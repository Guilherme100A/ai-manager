// CRUD de proxies e vínculo proxy ↔ sessão (AC-T06-01..03).
import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { proxies, sessions, type Database } from '@wsm/db'
import { decrypt, encrypt } from '../crypto'
import { isUniqueViolation, ProxyError } from './errors'
import { buildProxyUrl, maskProxyUrl, parseProxyUrl, type ProxyProtocolName } from './url'
import { checkProxySharing } from './sharing'

export type ProxyRow = typeof proxies.$inferSelect
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>

/** Representação pública: nunca contém senha nem campos cifrados. */
export interface ProxyView {
  id: string
  name: string | null
  protocol: ProxyProtocolName
  host: string
  port: number
  username: string | null
  /** URL mascarada: `http://user:***@host:port`. */
  url: string
  available: boolean
  lastCheckAt: Date | null
  lastError: string | null
  errorCount: number
  lastChangedAt: Date | null
  /** Sessão vinculada (null quando livre). */
  sessionId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ProxyInput {
  url: string
  name?: string | null
}

const aad = (proxyId: string) => `proxy:${proxyId}`

export function encryptProxyPassword(proxyId: string, password: string | null | undefined) {
  if (!password) return { passwordCiphertext: null, passwordIv: null, passwordAuthTag: null, passwordKeyVersion: null }
  const p = encrypt(password, { aad: aad(proxyId) })
  return { passwordCiphertext: p.ciphertext, passwordIv: p.iv, passwordAuthTag: p.authTag, passwordKeyVersion: p.keyVersion }
}

export function decryptProxyPassword(row: ProxyRow): string | null {
  if (!row.passwordCiphertext || !row.passwordIv || !row.passwordAuthTag || row.passwordKeyVersion == null) return null
  return decrypt<string>(
    { ciphertext: row.passwordCiphertext, iv: row.passwordIv, authTag: row.passwordAuthTag, keyVersion: row.passwordKeyVersion },
    { aad: aad(row.id) },
  )
}

/** URL completa, com a senha em claro. Uso exclusivo para montar o transporte; nunca logar. */
export function proxyConnectionUrl(row: ProxyRow): string {
  return buildProxyUrl({ ...row, password: decryptProxyPassword(row) })
}

export function toProxyView(row: ProxyRow, sessionId: string | null): ProxyView {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    username: row.username,
    url: maskProxyUrl({ ...row, hasPassword: row.passwordCiphertext != null }),
    available: row.available,
    lastCheckAt: row.lastCheckAt,
    lastError: row.lastError,
    errorCount: row.errorCount,
    lastChangedAt: row.lastChangedAt,
    sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export interface AssignResult {
  proxy: ProxyView
  sessionId: string
  previousProxyId: string | null
  /** false quando o vínculo já existia (nada mudou). */
  changed: boolean
}

export interface UnassignResult {
  proxy: ProxyView
  /** Sessão desvinculada (null se o proxy já estava livre). */
  sessionId: string | null
}

export class ProxyService {
  constructor(private readonly db: Database) {}

  async list(): Promise<ProxyView[]> {
    const rows = await this.db
      .select({ proxy: proxies, sessionId: sessions.id })
      .from(proxies)
      .leftJoin(sessions, eq(sessions.proxyId, proxies.id))
      .orderBy(asc(proxies.createdAt), asc(proxies.id))
    return rows.map((r) => toProxyView(r.proxy, r.sessionId))
  }

  async get(id: string): Promise<ProxyView> {
    const { row, sessionId } = await this.load(this.db, id)
    return toProxyView(row, sessionId)
  }

  async create(input: ProxyInput): Promise<ProxyView> {
    const parts = parseProxyUrl(input.url)
    const id = randomUUID()
    const [row] = await this.db
      .insert(proxies)
      .values({
        id,
        name: input.name ?? null,
        protocol: parts.protocol,
        host: parts.host,
        port: parts.port,
        username: parts.username ?? null,
        ...encryptProxyPassword(id, parts.password),
      })
      .returning()
    return toProxyView(row!, null)
  }

  /**
   * Atualiza nome e/ou URL. Mudar a URL de um proxy vinculado é mudança de rede da sessão:
   * atualiza `last_changed_at` e marca a sessão como "requer restart" (AC-T06-03).
   */
  async update(id: string, patch: Partial<ProxyInput>): Promise<ProxyView> {
    return this.db.transaction(async (tx) => {
      const { row, sessionId } = await this.load(tx, id, true)
      const values: Partial<typeof proxies.$inferInsert> = { updatedAt: new Date() }
      if (patch.name !== undefined) values.name = patch.name
      if (patch.url !== undefined) {
        const parts = parseProxyUrl(patch.url)
        Object.assign(values, {
          protocol: parts.protocol,
          host: parts.host,
          port: parts.port,
          username: parts.username ?? null,
          ...encryptProxyPassword(id, parts.password),
        })
        const before = proxyConnectionUrl(row)
        if (buildProxyUrl({ ...parts }) !== before) {
          values.lastChangedAt = new Date()
          if (sessionId) await markRequiresRestart(tx, sessionId)
        }
      }
      const [updated] = await tx.update(proxies).set(values).where(eq(proxies.id, id)).returning()
      return toProxyView(updated!, sessionId)
    })
  }

  /** Remove o proxy. Vinculado a uma sessão → `PROXY_IN_USE` (evita a sessão cair em conexão direta). */
  async delete(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { sessionId } = await this.load(tx, id, true)
      if (sessionId) throw new ProxyError('PROXY_IN_USE', `proxy ${id} is assigned to session ${sessionId}`)
      await tx.delete(proxies).where(eq(proxies.id, id))
    })
  }

  /**
   * Vincula o proxy à sessão (AC-T06-02/03). Proxy já em outra sessão → `PROXY_IN_USE`.
   * Troca (ou primeiro vínculo) atualiza `last_changed_at` do proxy e marca `requires_restart`;
   * o status da sessão não muda — a nova rede só vale após restart.
   */
  async assign(proxyId: string, sessionId: string): Promise<AssignResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const { row, sessionId: current } = await this.load(tx, proxyId, true)
        const [session] = await tx
          .select({ id: sessions.id, proxyId: sessions.proxyId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .for('update')
        if (!session) throw new ProxyError('SESSION_NOT_FOUND', `session ${sessionId} not found`)
        if (current && current !== sessionId) {
          throw new ProxyError('PROXY_IN_USE', `proxy ${proxyId} is already assigned to another session`)
        }
        if (session.proxyId === proxyId) {
          return { proxy: toProxyView(row, sessionId), sessionId, previousProxyId: proxyId, changed: false }
        }
        // Limite de chips por IP (quando ligado no painel).
        const refused = await checkProxySharing(tx, row.host, row.port, sessionId)
        if (refused) throw new ProxyError('PROXY_IN_USE', refused)
        const now = new Date()
        await tx.update(sessions).set({ proxyId, requiresRestart: true, updatedAt: now }).where(eq(sessions.id, sessionId))
        const [updated] = await tx
          .update(proxies)
          .set({ lastChangedAt: now, updatedAt: now })
          .where(eq(proxies.id, proxyId))
          .returning()
        return { proxy: toProxyView(updated!, sessionId), sessionId, previousProxyId: session.proxyId, changed: true }
      })
    } catch (err) {
      // Corrida: outra transação vinculou o mesmo proxy primeiro (UNIQUE sessions.proxy_id).
      if (isUniqueViolation(err)) throw new ProxyError('PROXY_IN_USE', `proxy ${proxyId} is already assigned to another session`)
      throw err
    }
  }

  /** Desvincula o proxy da sessão atual (se houver) e marca a sessão como "requer restart". */
  async unassign(proxyId: string): Promise<UnassignResult> {
    return this.db.transaction(async (tx) => {
      const { row, sessionId } = await this.load(tx, proxyId, true)
      if (!sessionId) return { proxy: toProxyView(row, null), sessionId: null }
      const now = new Date()
      await tx.update(sessions).set({ proxyId: null, requiresRestart: true, updatedAt: now }).where(eq(sessions.id, sessionId))
      const [updated] = await tx
        .update(proxies)
        .set({ lastChangedAt: now, updatedAt: now })
        .where(eq(proxies.id, proxyId))
        .returning()
      return { proxy: toProxyView(updated!, null), sessionId }
    })
  }

  private async load(db: Executor, id: string, lock = false): Promise<{ row: ProxyRow; sessionId: string | null }> {
    const q = db.select().from(proxies).where(eq(proxies.id, id))
    const [row] = lock ? await q.for('update') : await q
    if (!row) throw new ProxyError('PROXY_NOT_FOUND', `proxy ${id} not found`)
    const [s] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.proxyId, id))
    return { row, sessionId: s?.id ?? null }
  }
}

async function markRequiresRestart(db: Executor, sessionId: string) {
  await db.update(sessions).set({ requiresRestart: true, updatedAt: sql`now()` }).where(eq(sessions.id, sessionId))
}
