// Limites de envio por sessão (T09, AC-T09-05): configuráveis, com defaults conservadores.
// O sistema pode REDUZIR limites automaticamente (reduce), mas nunca aumentá-los; o limite diário efetivo
// nunca passa do cronograma de warm-up (T10). Aumentar é sempre ação manual (set).
import { and, count, eq, gt, isNull, ne, or } from 'drizzle-orm'
import { messages, sessionLimits, type Database } from '@wsm/db'
import { SessionStore, type SessionRow } from '../session/store'
import type { SessionState } from '../session/states'
import { computeWarmup, DAY_MS, resolveWarmupSchedule, type WarmupSchedule } from '../warmup'

export interface SendLimits {
  perMinute: number
  perHour: number
  perDay: number
}

/** Defaults conservadores (preset `conservative` do baileys-antiban). */
export const DEFAULT_SEND_LIMITS: Readonly<SendLimits> = Object.freeze({ perMinute: 5, perHour: 100, perDay: 800 })
/** Piso do fator de redução automática. */
export const MIN_REDUCTION_FACTOR = 0.1
/** Fator aplicado (sem gravar) enquanto a sessão está DEGRADED. */
export const DEGRADED_LIMIT_FACTOR = 0.5

export interface EffectiveLimitsInput {
  configured: SendLimits
  reductionFactor: number
  state: SessionState
  /** Limite diário do warm-up; null = warm-up concluído. */
  warmupDailyLimit: number | null
}

export interface EffectiveLimits extends SendLimits {
  /** Limite do warm-up já com a redução aplicada; null = sem limite de warm-up. */
  warmupDailyLimit: number | null
  factor: number
}

const scale = (n: number, factor: number) => Math.max(1, Math.floor(n * factor))

/** Função pura: limites efetivos. Nunca maiores que os configurados; perDay nunca passa do cronograma de warm-up. */
export function computeEffectiveLimits(input: EffectiveLimitsInput): EffectiveLimits {
  const factor = Math.min(1, Math.max(MIN_REDUCTION_FACTOR, input.reductionFactor)) * (input.state === 'DEGRADED' ? DEGRADED_LIMIT_FACTOR : 1)
  const warmup = input.warmupDailyLimit === null ? null : input.warmupDailyLimit === 0 ? 0 : scale(input.warmupDailyLimit, factor)
  let perDay = scale(input.configured.perDay, factor)
  if (warmup !== null) perDay = Math.min(perDay, warmup)
  return { perMinute: scale(input.configured.perMinute, factor), perHour: scale(input.configured.perHour, factor), perDay, warmupDailyLimit: warmup, factor }
}

export interface SessionLimitsView {
  sessionId: string
  /** Configurado (manual) ou default. */
  configured: SendLimits
  defaults: SendLimits
  reductionFactor: number
  reductionReason: string | null
  reducedAt: string | null
  degraded: boolean
  /** Limite diário do cronograma de warm-up (T10) hoje; null = warm-up concluído. */
  warmupDailyLimit: number | null
  warmup: { day: number; percent: number; complete: boolean; dailyLimit: number | null; dayStartedAt: string | null }
  /** Limites aplicados pelos gates warmupLimit/rateLimit. */
  effective: EffectiveLimits
}

export interface SessionLimitsServiceOptions {
  db?: Database
  now?: () => Date
  schedule?: Partial<WarmupSchedule>
  defaults?: Partial<SendLimits>
}

export type LimitsInput = Partial<SendLimits>

export class InvalidLimitsError extends Error {
  readonly code = 'VALIDATION_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidLimitsError'
  }
}

export class SessionLimitsService {
  readonly store: SessionStore
  readonly defaults: SendLimits
  private readonly now: () => Date
  private readonly schedule: WarmupSchedule

  readonly db: Database

  /** `new SessionLimitsService(db, opts?)` ou `new SessionLimitsService({ db, ...opts })`. */
  constructor(dbOrOpts: Database | (SessionLimitsServiceOptions & { db: Database }), opts: SessionLimitsServiceOptions = {}) {
    if (isOptions(dbOrOpts)) {
      opts = { ...dbOrOpts, ...opts }
      this.db = dbOrOpts.db
    } else {
      this.db = dbOrOpts
    }
    const db = this.db
    this.store = new SessionStore(db)
    this.now = opts.now ?? (() => new Date())
    this.schedule = resolveWarmupSchedule(opts.schedule)
    this.defaults = { ...DEFAULT_SEND_LIMITS, ...stripUndefined(opts.defaults ?? {}) }
  }

  async get(sessionId: string): Promise<SessionLimitsView> {
    return this.view(await this.store.get(sessionId))
  }

  /** Limites da sessão já carregada (evita reler a sessão no pipeline). */
  async view(session: SessionRow): Promise<SessionLimitsView> {
    const [row] = await this.db.select().from(sessionLimits).where(eq(sessionLimits.sessionId, session.id))
    const configured: SendLimits = {
      perMinute: row?.perMinute ?? this.defaults.perMinute,
      perHour: row?.perHour ?? this.defaults.perHour,
      perDay: row?.perDay ?? this.defaults.perDay,
    }
    const now = this.now()
    const w = computeWarmup({ startedAt: session.warmupStartedAt, now, schedule: this.schedule })
    const dayStartedAt = session.warmupStartedAt && !w.complete ? new Date(session.warmupStartedAt.getTime() + w.day * DAY_MS) : null
    const reductionFactor = row?.reductionFactor ?? 1
    return {
      sessionId: session.id,
      configured,
      defaults: { ...this.defaults },
      reductionFactor,
      reductionReason: row?.reductionReason ?? null,
      reducedAt: row?.reducedAt ? row.reducedAt.toISOString() : null,
      degraded: session.status === 'DEGRADED',
      warmupDailyLimit: w.dailyLimit,
      warmup: { day: w.day, percent: w.percent, complete: w.complete, dailyLimit: w.dailyLimit, dayStartedAt: dayStartedAt?.toISOString() ?? null },
      effective: computeEffectiveLimits({ configured, reductionFactor, state: session.status, warmupDailyLimit: w.dailyLimit }),
    }
  }

  /** Ajuste MANUAL (API): grava os limites informados e zera a redução automática. */
  async set(sessionId: string, input: LimitsInput): Promise<SessionLimitsView> {
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined && (!Number.isInteger(v) || v < 1)) throw new InvalidLimitsError(`${k} must be an integer >= 1`)
    }
    const session = await this.store.get(sessionId)
    const values = stripUndefined(input)
    await this.db
      .insert(sessionLimits)
      .values({ sessionId, ...values, reductionFactor: 1, reductionReason: null, reducedAt: null })
      .onConflictDoUpdate({
        target: sessionLimits.sessionId,
        set: { ...values, reductionFactor: 1, reductionReason: null, reducedAt: null, updatedAt: new Date() },
      })
    return this.view(session)
  }

  /**
   * Redução AUTOMÁTICA: multiplica o fator por `factor` (0 < factor < 1), com piso MIN_REDUCTION_FACTOR.
   * Nunca aumenta o fator. Fatores >= 1 são ignorados.
   */
  async reduce(sessionId: string, factor: number, reason: string): Promise<SessionLimitsView> {
    const session = await this.store.get(sessionId)
    if (!(factor > 0 && factor < 1)) return this.view(session)
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(sessionLimits).where(eq(sessionLimits.sessionId, sessionId)).for('update')
      const current = row?.reductionFactor ?? 1
      const next = Math.max(MIN_REDUCTION_FACTOR, current * factor)
      if (next >= current) return
      const set = { reductionFactor: next, reductionReason: reason, reducedAt: this.now(), updatedAt: new Date() }
      await tx.insert(sessionLimits).values({ sessionId, ...set }).onConflictDoUpdate({ target: sessionLimits.sessionId, set })
    })
    return this.view(session)
  }

  /** Mensagens outbound da sessão (qualquer status exceto cancelled) criadas depois de `since`. */
  /** Envios que contam nos limites da sessão (e do warm-up). Os do CRM (`origin = 'crm'`) não contam. */
  async countOutbound(sessionId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.direction, 'outbound'),
          ne(messages.status, 'cancelled'),
          gt(messages.createdAt, since),
          or(isNull(messages.origin), ne(messages.origin, 'crm')),
        ),
      )
    return Number(row?.n ?? 0)
  }

  nowDate(): Date {
    return this.now()
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

function isOptions(v: unknown): v is SessionLimitsServiceOptions & { db: Database } {
  return typeof v === 'object' && v !== null && 'db' in v && typeof (v as { select?: unknown }).select !== 'function'
}
