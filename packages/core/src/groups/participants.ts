// T20 — adicionar UM número (outra sessão do sistema) a um grupo em que a sessão é admin.
// É uma ação MANUAL: só a rota autenticada da API chama `add`, um alvo por vez. Não existe lote, fila, timer,
// escolha de grupos por IA nem entrada da própria conta em grupos (SPEC 1.4 #5).
// Freio anti-rajada: no máximo 1 tentativa (que chega ao transporte) por minuto por sessão admin.
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { auditLogs, type Database } from '@wsm/db'
import { SENDABLE_STATES } from '../session/states'
import { SessionStore } from '../session/store'
import { TransportNotConnectedError, type GroupParticipantStatus, type WaTransport } from '../transport'

export const GROUP_ADD_AUDIT_ACTION = 'group.participant.add'
/** Janela do freio anti-rajada: 1 tentativa por minuto por sessão admin. */
export const GROUP_ADD_WINDOW_MS = 60_000
/** Tempo máximo que uma tentativa concluída espera a auditoria aparecer antes de a reserva ser liberada. */
export const GROUP_ADD_PENDING_MAX_MS = 15_000

/** Resultado registrado na auditoria (sucesso ou motivo da falha). */
export type GroupAddResultKind =
  | GroupParticipantStatus
  | 'rate_limited'
  | 'not_connected'
  | 'session_not_found'
  | 'target_not_found'
  | 'invalid_target'

export type GroupAddErrorCode = 'VALIDATION_ERROR' | 'SESSION_NOT_FOUND' | 'SESSION_NOT_CONNECTED' | 'GROUP_NOT_FOUND' | 'NOT_GROUP_ADMIN' | 'RATE_LIMIT'

export const GROUP_ADD_ERROR_STATUS: Record<GroupAddErrorCode, number> = {
  VALIDATION_ERROR: 400,
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_CONNECTED: 409,
  GROUP_NOT_FOUND: 404,
  NOT_GROUP_ADMIN: 403,
  RATE_LIMIT: 429,
}

export interface GroupAddDetails {
  result: GroupAddResultKind
  /** A tentativa chegou ao transporte (conta no freio). */
  attempted: boolean
  jid: string | null
  field?: string
  retryAfterMs?: number
  code?: number
  /** Identificador da tentativa (gravar na auditoria: libera a reserva em memória). */
  attemptId?: string
  /** Relógio do serviço no momento da tentativa (gravar na auditoria: janela com relógio injetável). */
  clockAt?: number
}

export class GroupAddError extends Error {
  readonly status: number
  constructor(
    readonly code: GroupAddErrorCode,
    message: string,
    readonly details: GroupAddDetails,
  ) {
    super(message)
    this.name = 'GroupAddError'
    this.status = GROUP_ADD_ERROR_STATUS[code]
  }
}

export interface GroupAddInput {
  adminSessionId: string
  groupId: string
  targetSessionId: string
}

export interface GroupAddOutcome {
  groupId: string
  targetSessionId: string
  jid: string
  result: 'added' | 'already_member' | 'not_allowed' | 'failed'
  code?: number
  attempted: true
  attemptId: string
  clockAt: number
}

export interface GroupParticipantServiceOptions {
  db: Database
  /** Transporte vivo e conectado da sessão (ex.: manager.isConnected(id) ? manager.getTransport(id) : undefined). */
  getTransport?: (sessionId: string) => WaTransport | undefined
  /** Relógio em ms (injetável em testes). */
  now?: () => number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Telefone E.164 → JID de usuário do WhatsApp. */
export function phoneToUserJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`
}

export class GroupParticipantService {
  private readonly store: SessionStore
  private readonly now: () => number
  /**
   * Reserva por sessão admin: enquanto a tentativa está em voo e até a auditoria dela (attemptId) aparecer no banco
   * (teto GROUP_ADD_PENDING_MAX_MS). Depois disso quem decide é só audit_logs.
   */
  private readonly pending = new Map<string, { attemptId: string; done: boolean; finishedAt: number }>()

  constructor(private readonly opts: GroupParticipantServiceOptions) {
    this.store = new SessionStore(opts.db)
    this.now = opts.now ?? (() => Date.now())
  }

  /** Adiciona UM número. Erros (com o motivo em `details.result`) são GroupAddError. */
  async addGroupParticipant(adminSessionId: string, groupId: string, targetSessionId: string): Promise<GroupAddOutcome> {
    return this.add({ adminSessionId, groupId, targetSessionId })
  }

  async add(input: GroupAddInput): Promise<GroupAddOutcome> {
    const { adminSessionId, groupId, targetSessionId } = input
    const fail = (code: GroupAddErrorCode, message: string, details: Partial<GroupAddDetails> & Pick<GroupAddDetails, 'result'>): never => {
      throw new GroupAddError(code, message, { attempted: false, jid: null, ...details })
    }

    const admin = UUID_RE.test(adminSessionId) ? await this.store.find(adminSessionId) : undefined
    if (!admin) fail('SESSION_NOT_FOUND', `session ${adminSessionId} not found`, { result: 'session_not_found' })
    if (typeof groupId !== 'string' || !groupId.trim() || groupId.length > 200) fail('VALIDATION_ERROR', 'invalid group id', { result: 'invalid_target', field: 'groupId' })
    if (targetSessionId === adminSessionId) {
      fail('VALIDATION_ERROR', 'target session must be different from the admin session', { result: 'invalid_target', field: 'targetSessionId' })
    }
    const target = UUID_RE.test(targetSessionId) ? await this.store.find(targetSessionId) : undefined
    if (!target) fail('SESSION_NOT_FOUND', `target session ${targetSessionId} not found`, { result: 'target_not_found', field: 'targetSessionId' })
    if (!target!.phone?.trim()) fail('VALIDATION_ERROR', 'target session has no phone number', { result: 'invalid_target', field: 'targetSessionId' })
    const jid = phoneToUserJid(target!.phone!)

    if (!SENDABLE_STATES.includes(admin!.status)) {
      fail('SESSION_NOT_CONNECTED', `session ${adminSessionId} is ${admin!.status}, not connected`, { result: 'not_connected', jid })
    }
    const transport = this.opts.getTransport?.(adminSessionId)
    if (!transport) fail('SESSION_NOT_CONNECTED', `session ${adminSessionId} has no open connection`, { result: 'not_connected', jid })

    // Admin e existência do grupo pela lista de grupos (não chega ao transporte de adição, não conta no freio).
    let groups
    try {
      groups = await transport!.fetchGroups()
    } catch (err) {
      if (err instanceof TransportNotConnectedError) fail('SESSION_NOT_CONNECTED', `session ${adminSessionId} is not connected`, { result: 'not_connected', jid })
      throw err
    }
    const group = groups!.find((g) => g.id === groupId)
    if (!group) fail('GROUP_NOT_FOUND', `group ${groupId} not found for this session`, { result: 'group_not_found', jid })
    if (group!.isAdmin !== true) fail('NOT_GROUP_ADMIN', 'this session is not an admin of the group', { result: 'not_admin', jid })

    // Freio anti-rajada: tentativa registrada nos últimos 60 s (audit_logs) ou reserva em memória.
    // Leituras primeiro; decisão e reserva depois, sem await entre elas (requisições simultâneas nunca passam juntas).
    // Ordem importa: primeiro se a tentativa anterior já foi auditada, DEPOIS a janela; assim, se a reserva for
    // liberada porque a auditoria apareceu, a janela lida já contém essa auditoria.
    const before = this.pending.get(adminSessionId)
    const audited = before?.done ? await this.isAudited(before.attemptId) : false
    const retryAfterMs = await this.retryAfter(adminSessionId)
    const reserved = this.pending.get(adminSessionId)
    if (reserved) {
      const expired = reserved.done && Date.now() - reserved.finishedAt > GROUP_ADD_PENDING_MAX_MS
      if (reserved.done && ((reserved === before && audited) || expired)) this.pending.delete(adminSessionId)
      else fail('RATE_LIMIT', 'an add is already in progress for this session', { result: 'rate_limited', jid, retryAfterMs: GROUP_ADD_WINDOW_MS })
    }
    if (retryAfterMs > 0) fail('RATE_LIMIT', 'limit: 1 add per minute per admin session', { result: 'rate_limited', jid, retryAfterMs })
    const attempt = { attemptId: randomUUID(), done: false, finishedAt: 0 }
    this.pending.set(adminSessionId, attempt)
    const clockAt = this.now()
    const track = { attemptId: attempt.attemptId, clockAt }
    try {
      let items
      try {
        items = await transport!.addGroupParticipant(groupId, jid)
      } catch (err) {
        if (err instanceof TransportNotConnectedError) {
          throw new GroupAddError('SESSION_NOT_CONNECTED', `session ${adminSessionId} is not connected`, { result: 'not_connected', attempted: true, jid, ...track })
        }
        return { groupId, targetSessionId, jid, result: 'failed', attempted: true, ...track }
      }
      const item = items.find((i) => i.jid === jid) ?? items[0]
      const status = item?.status ?? 'failed'
      const code = item?.code
      const extra = code === undefined ? {} : { code }
      if (status === 'not_admin') throw new GroupAddError('NOT_GROUP_ADMIN', 'this session is not an admin of the group', { result: 'not_admin', attempted: true, jid, ...extra, ...track })
      if (status === 'group_not_found') throw new GroupAddError('GROUP_NOT_FOUND', `group ${groupId} not found`, { result: 'group_not_found', attempted: true, jid, ...extra, ...track })
      return { groupId, targetSessionId, jid, result: status, attempted: true, ...extra, ...track }
    } finally {
      attempt.done = true
      attempt.finishedAt = Date.now()
    }
  }

  private async isAudited(attemptId: string): Promise<boolean> {
    const [row] = await this.opts.db
      .select({ one: sql<number>`1` })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, GROUP_ADD_AUDIT_ACTION), sql`${auditLogs.detail}->>'attemptId' = ${attemptId}`))
      .limit(1)
    return row !== undefined
  }

  /**
   * ms até a próxima tentativa permitida (0 = liberado), pelas tentativas auditadas da sessão admin.
   * Uma tentativa conta enquanto estiver na janela pelo relógio do banco (created_at) E pelo relógio do serviço
   * (detail.clockAt): recuar o created_at ou avançar o relógio injetado libera.
   */
  async retryAfter(adminSessionId: string): Promise<number> {
    const now = this.now()
    const rows = await this.opts.db
      .select({
        remainingDb: sql<number>`(extract(epoch from (${auditLogs.createdAt} + interval '60 seconds' - now())) * 1000)::float8`,
        clockAt: sql<string | null>`${auditLogs.detail}->>'clockAt'`,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, GROUP_ADD_AUDIT_ACTION),
          eq(auditLogs.targetType, 'session'),
          eq(auditLogs.targetId, adminSessionId),
          sql`${auditLogs.detail}->>'attempted' = 'true'`,
          sql`${auditLogs.createdAt} > now() - interval '60 seconds'`,
        ),
      )
    let wait = 0
    for (const r of rows) {
      const byDb = Number(r.remainingDb)
      const clockAt = r.clockAt === null ? NaN : Number(r.clockAt)
      const byClock = Number.isFinite(clockAt) ? clockAt + GROUP_ADD_WINDOW_MS - now : byDb
      wait = Math.max(wait, Math.min(byDb, byClock))
    }
    return Math.min(GROUP_ADD_WINDOW_MS, Math.max(0, Math.ceil(wait)))
  }
}
