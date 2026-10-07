// Mede travamentos do processo (event loop parado): com o loop parado, o worker não responde o keepalive das
// conexões e o WhatsApp pode derrubar vários chips juntos. Cada travamento vira um registro para o relatório, com o
// resumo do que rodou antes, e deixa o worker em "modo alívio" (automações não essenciais pausadas) por um tempo.
import { auditLogs, type Database } from '@wsm/db'
import type { ActivityLog } from './activity'

export const STALL_THRESHOLD_MS = 1000
export const STALL_TICK_MS = 250
export const STALL_ACTION = 'worker.stall'
/** Depois de um travamento, quanto tempo as automações não essenciais ficam pausadas. */
export const PRESSURE_MS = 5 * 60_000
/** Quantos segundos antes do travamento entram no resumo de atividade. */
const ACTIVITY_LOOKBACK_MS = 3000

/** Detector puro: recebe o relógio a cada tick e devolve o atraso quando passou do limite. */
export function createStallDetector(opts: { tickMs?: number; thresholdMs?: number; start: number }) {
  const tickMs = opts.tickMs ?? STALL_TICK_MS
  const thresholdMs = opts.thresholdMs ?? STALL_THRESHOLD_MS
  let last = opts.start
  return (now: number): number | undefined => {
    const lag = now - last - tickMs
    last = now
    return lag >= thresholdMs ? lag : undefined
  }
}

export interface StallMonitorOptions {
  db: Pick<Database, 'insert'>
  logger: { warn(obj: object, message?: string): void }
  activity?: ActivityLog
  tickMs?: number
  thresholdMs?: number
  pressureMs?: number
  now?: () => number
}

export interface StallMonitor {
  stop(): void
  /** Houve travamento recente: automações não essenciais devem esperar. */
  underPressure(): boolean
}

export function startStallMonitor(opts: StallMonitorOptions): StallMonitor {
  const now = opts.now ?? Date.now
  const tickMs = opts.tickMs ?? STALL_TICK_MS
  const pressureMs = opts.pressureMs ?? PRESSURE_MS
  const detect = createStallDetector({ tickMs, ...(opts.thresholdMs ? { thresholdMs: opts.thresholdMs } : {}), start: now() })
  let lastStallAt = -Infinity
  const timer = setInterval(() => {
    const at = now()
    const lag = detect(at)
    if (lag === undefined) return
    const enteringPressure = at - lastStallAt >= pressureMs
    lastStallAt = at
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1_048_576)
    const activity = opts.activity?.summary(at - lag - ACTIVITY_LOOKBACK_MS, at) ?? {}
    opts.logger.warn({ lag_ms: lag, heap_mb: heapMb, activity, pressure: true }, enteringPressure
      ? 'worker event loop stalled: pausing non-essential automations'
      : 'worker event loop stalled')
    void opts.db
      .insert(auditLogs)
      .values({ actor: 'worker', action: STALL_ACTION, targetType: 'worker', detail: { lagMs: lag, heapMb, activity } })
      .catch(() => undefined)
  }, tickMs)
  timer.unref?.()
  return {
    stop: () => clearInterval(timer),
    underPressure: () => now() - lastStallAt < pressureMs,
  }
}
