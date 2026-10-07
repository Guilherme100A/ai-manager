// Mede travamentos do processo (event loop parado): com o loop parado, o worker não responde o keepalive das
// conexões e o WhatsApp pode derrubar vários chips juntos. Cada travamento vira um registro para o relatório.
import { auditLogs, type Database } from '@wsm/db'

export const STALL_THRESHOLD_MS = 1000
export const STALL_TICK_MS = 250
export const STALL_ACTION = 'worker.stall'

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
  tickMs?: number
  thresholdMs?: number
}

export function startStallMonitor(opts: StallMonitorOptions): { stop(): void } {
  const tickMs = opts.tickMs ?? STALL_TICK_MS
  const detect = createStallDetector({ tickMs, ...(opts.thresholdMs ? { thresholdMs: opts.thresholdMs } : {}), start: Date.now() })
  const timer = setInterval(() => {
    const lag = detect(Date.now())
    if (lag === undefined) return
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1_048_576)
    opts.logger.warn({ lag_ms: lag, heap_mb: heapMb }, 'worker event loop stalled')
    void opts.db
      .insert(auditLogs)
      .values({ actor: 'worker', action: STALL_ACTION, targetType: 'worker', detail: { lagMs: lag, heapMb } })
      .catch(() => undefined)
  }, tickMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
