import { desc, inArray } from 'drizzle-orm'
import { SENDABLE_STATES, SpyProbeError, SpyProbeStore } from '@wsm/core'
import { sessions, type Database } from '@wsm/db'
import type { Logger } from 'pino'
import type { RedisLike } from './types'

export const SPY_AUTO_PROBE_KEY = 'wsm:spy:auto-probe'

export interface SpyAutoProbeConfig {
  excludedSessionIds: string[]
}

export async function loadSpyAutoProbeConfig(redis: RedisLike): Promise<SpyAutoProbeConfig> {
  const raw = await redis.get(SPY_AUTO_PROBE_KEY)
  if (!raw) return { excludedSessionIds: [] }
  try {
    const parsed = JSON.parse(raw) as { excludedSessionIds?: unknown }
    return {
      excludedSessionIds: Array.isArray(parsed.excludedSessionIds)
        ? [...new Set(parsed.excludedSessionIds.filter((id): id is string => typeof id === 'string'))]
        : [],
    }
  } catch {
    return { excludedSessionIds: [] }
  }
}

export async function saveSpyAutoProbeConfig(redis: RedisLike, config: SpyAutoProbeConfig): Promise<SpyAutoProbeConfig> {
  const normalized = { excludedSessionIds: [...new Set(config.excludedSessionIds)] }
  await redis.set(SPY_AUTO_PROBE_KEY, JSON.stringify(normalized))
  return normalized
}

/** Escolhe o chip conectado mais recente; se ele atingiu o limite, tenta o próximo. */
export async function startAutomaticSpyProbe(opts: {
  db: Database
  redis: RedisLike
  logger: Logger
  offerId: string
}) {
  const excluded = new Set((await loadSpyAutoProbeConfig(opts.redis)).excludedSessionIds)
  const available = await opts.db.select().from(sessions)
    .where(inArray(sessions.status, [...SENDABLE_STATES]))
    .orderBy(desc(sessions.lastConnectedAt), desc(sessions.updatedAt))
  const probes = new SpyProbeStore(opts.db)

  for (const session of available) {
    if (excluded.has(session.id)) continue
    try {
      const probe = await probes.create({ offerId: opts.offerId, sessionId: session.id, branch: 'principal', createdBy: 'spy-auto' })
      opts.logger.info({ offer_id: opts.offerId, session_id: session.id, probe_id: probe.id }, 'spy: sonda automática iniciada')
      return probe
    } catch (err) {
      if (err instanceof SpyProbeError && err.code === 'PROBE_ACTIVE') return undefined
      if (err instanceof SpyProbeError && ['SESSION_NOT_READY', 'DAILY_LIMIT', 'OWN_NUMBER'].includes(err.code)) continue
      throw err
    }
  }
  opts.logger.warn({ offer_id: opts.offerId, excluded: excluded.size }, 'spy: nenhum chip elegível para sonda automática')
  return undefined
}
