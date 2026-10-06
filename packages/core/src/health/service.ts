// T10 — coleta dos sinais de saúde de uma sessão (messages + health_events) e visão do AC-T10-04.
import { and, count, desc, eq, gt, inArray, lte, max, sql } from 'drizzle-orm'
import { healthEvents, messages, type Database } from '@wsm/db'
import { SessionStore, type SessionRow } from '../session/store'
import type { SessionState } from '../session/states'
import { computeWarmup, resolveWarmupSchedule, type WarmupSchedule, type WarmupStatus } from '../warmup'
import { computeHealthScore, type HealthLabel } from './score'

/** Janela padrão dos contadores do score: 24h. */
export const DEFAULT_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000
/** Rajada de quedas: a partir da 3ª dentro de 60 min (regra do baileys-antiban). */
export const DISCONNECT_BURST_SIZE = 3
export const DISCONNECT_BURST_WINDOW_MS = 60 * 60 * 1000

/** Tipos de health_event gravados pelo monitor (T10) e pelo SessionManager (T05). */
export const HEALTH_EVENT_TYPES = {
  disconnected: 'disconnected',
  forbidden403: 'forbidden_403',
  degraded: 'health_degraded',
  recovered: 'health_recovered',
  autoPaused: 'auto_paused',
  warmupCompleted: 'warmup_completed',
  resumed: 'resumed',
  errorBurst: 'error_burst',
} as const

/** Resposta de GET /api/sessions/:id/health (AC-T10-04). */
export interface SessionHealth {
  state: SessionState
  warmupPercent: number
  score: number
  label: HealthLabel
  sent: number
  received: number
  failed: number
  disconnects: number
  forbidden403: number
  lastEventAt: string | null
}

export interface HealthStats {
  sent: number
  received: number
  failed: number
  disconnects: number
  /** Quedas em rajada: a 3ª em diante dentro de 60 min. Só elas pesam no score; quedas isoladas são rotina do WhatsApp. */
  burstDisconnects: number
  forbidden403: number
  /** Falhas de envio da metade recente da janela (quedas ficam fora: já pesam em burstDisconnects). */
  recentErrors: number
  /** Erros da metade anterior da janela. */
  previousErrors: number
  errorTrend: number
  /** Início efetivo da janela (exclusivo): max(now - windowMs, último resume manual). */
  since: Date
  lastEventAt: Date | null
}

export interface HealthServiceOptions {
  now?: () => Date
  schedule?: Partial<WarmupSchedule>
  windowMs?: number
}

export interface HealthEvaluation {
  row: SessionRow
  stats: HealthStats
  warmup: WarmupStatus
  score: number
  label: HealthLabel
  health: SessionHealth
}

export class HealthService {
  readonly store: SessionStore
  readonly schedule: WarmupSchedule
  readonly windowMs: number
  readonly now: () => Date

  constructor(
    readonly db: Database,
    opts: HealthServiceOptions = {},
  ) {
    this.store = new SessionStore(db)
    this.schedule = resolveWarmupSchedule(opts.schedule)
    this.windowMs = opts.windowMs ?? DEFAULT_HEALTH_WINDOW_MS
    this.now = opts.now ?? (() => new Date())
  }

  warmup(row: Pick<SessionRow, 'warmupStartedAt'>, now = this.now()): WarmupStatus {
    return computeWarmup({ startedAt: row.warmupStartedAt, now, schedule: this.schedule })
  }

  /** Contadores da janela (now - windowMs, now]; sinais até o último resume manual não contam. */
  async stats(sessionId: string, now = this.now()): Promise<HealthStats> {
    const windowStart = new Date(now.getTime() - this.windowMs)
    const [resume] = await this.db
      .select({ at: max(healthEvents.createdAt) })
      .from(healthEvents)
      .where(and(eq(healthEvents.sessionId, sessionId), eq(healthEvents.type, HEALTH_EVENT_TYPES.resumed), lte(healthEvents.createdAt, now)))
    const since = resume?.at && resume.at > windowStart ? resume.at : windowStart
    const mid = new Date(now.getTime() - this.windowMs / 2)

    const inWindow = (col: typeof messages.createdAt | typeof healthEvents.createdAt) => and(gt(col, since), lte(col, now))
    const recent = (col: typeof messages.createdAt | typeof healthEvents.createdAt) => sql<number>`count(*) filter (where ${col} > ${mid})`

    const msgRows = await this.db
      .select({
        kind: sql<string>`case
          when ${messages.direction} = 'inbound' then 'received'
          when ${messages.status} in ('sent','delivered','read') then 'sent'
          when ${messages.status} = 'failed' then 'failed'
          else 'other' end`,
        total: count(),
        recent: recent(messages.createdAt),
      })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), inWindow(messages.createdAt)))
      .groupBy(sql`1`)

    const evRows = await this.db
      .select({ type: healthEvents.type, total: count(), recent: recent(healthEvents.createdAt) })
      .from(healthEvents)
      .where(
        and(
          eq(healthEvents.sessionId, sessionId),
          inArray(healthEvents.type, [HEALTH_EVENT_TYPES.disconnected, HEALTH_EVENT_TYPES.forbidden403]),
          inWindow(healthEvents.createdAt),
        ),
      )
      .groupBy(healthEvents.type)

    const [last] = await this.db
      .select({ at: healthEvents.createdAt })
      .from(healthEvents)
      .where(and(eq(healthEvents.sessionId, sessionId), lte(healthEvents.createdAt, now)))
      .orderBy(desc(healthEvents.createdAt))
      .limit(1)

    const msg = (k: string) => msgRows.find((r) => r.kind === k)
    const ev = (t: string) => evRows.find((r) => r.type === t)
    const n = (v: unknown) => Number(v ?? 0)

    const failedRow = msg('failed')
    const discRow = ev(HEALTH_EVENT_TYPES.disconnected)
    const recentErrors = n(failedRow?.recent)
    const previousErrors = n(failedRow?.total) - recentErrors

    const discTimes = (await this.db
      .select({ at: healthEvents.createdAt })
      .from(healthEvents)
      .where(and(eq(healthEvents.sessionId, sessionId), eq(healthEvents.type, HEALTH_EVENT_TYPES.disconnected), inWindow(healthEvents.createdAt)))
      .orderBy(healthEvents.createdAt)).map((r) => r.at.getTime())
    let burstDisconnects = 0
    for (let i = DISCONNECT_BURST_SIZE - 1; i < discTimes.length; i++) {
      if (discTimes[i]! - discTimes[i - DISCONNECT_BURST_SIZE + 1]! <= DISCONNECT_BURST_WINDOW_MS) burstDisconnects++
    }

    return {
      sent: n(msg('sent')?.total),
      received: n(msg('received')?.total),
      failed: n(failedRow?.total),
      disconnects: n(discRow?.total),
      burstDisconnects,
      forbidden403: n(ev(HEALTH_EVENT_TYPES.forbidden403)?.total),
      recentErrors,
      previousErrors,
      errorTrend: recentErrors - previousErrors,
      since,
      lastEventAt: last?.at ?? null,
    }
  }

  /** Estado + warm-up + score da sessão. SessionError SESSION_NOT_FOUND se não existir. */
  async evaluate(sessionId: string): Promise<HealthEvaluation> {
    const now = this.now()
    const row = await this.store.get(sessionId)
    const stats = await this.stats(sessionId, now)
    const warmup = this.warmup(row, now)
    const { score, label } = computeHealthScore({ ...stats, disconnects: stats.burstDisconnects })
    return { row, stats, warmup, score, label, health: toSessionHealth(row.status, warmup, score, label, stats) }
  }

  async getHealth(sessionId: string): Promise<SessionHealth> {
    return (await this.evaluate(sessionId)).health
  }
}

export function toSessionHealth(state: SessionState, warmup: WarmupStatus, score: number, label: HealthLabel, stats: HealthStats): SessionHealth {
  return {
    state,
    warmupPercent: warmup.percent,
    score,
    label,
    sent: stats.sent,
    received: stats.received,
    failed: stats.failed,
    disconnects: stats.disconnects,
    forbidden403: stats.forbidden403,
    lastEventAt: stats.lastEventAt ? stats.lastEventAt.toISOString() : null,
  }
}
