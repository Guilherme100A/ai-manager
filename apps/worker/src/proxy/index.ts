// Monitor de proxies no worker (AC-T06-04): roda o verificador periódico e repassa `proxy_unavailable`.
// Não altera o vínculo proxy ↔ sessão nem troca de rede: sessões com proxy indisponível falham ao conectar (AC-T06-05).
import { createProxyChecker, type CheckerLogger, type ProxyAvailableEvent, type ProxyChecker, type ProxyProbe, type ProxyUnavailableEvent } from '@wsm/core'
import type { Database } from '@wsm/db'

export interface ProxyMonitorOptions {
  db: Database
  logger?: CheckerLogger
  intervalMs?: number
  timeoutMs?: number
  probe?: ProxyProbe
  /** Consumidores do evento (ex.: alertas T11). */
  onUnavailable?: (event: ProxyUnavailableEvent) => void
  /** Proxy respondeu: reconecta as sessões que caíram só por ele estar indisponível. */
  onAvailable?: (event: ProxyAvailableEvent) => void
}

export interface ProxyMonitor {
  checker: ProxyChecker
  stop(): void
}

export function startProxyMonitor(opts: ProxyMonitorOptions): ProxyMonitor {
  const checker = createProxyChecker(opts)
  if (opts.onUnavailable) checker.on('proxy_unavailable', opts.onUnavailable)
  if (opts.onAvailable) checker.on('proxy_available', opts.onAvailable)
  checker.start()
  return { checker, stop: () => checker.stop() }
}
