// Verificador periódico de proxies (AC-T06-04). Nunca troca nem desliga proxy de sessão:
// só registra o estado e emite `proxy_unavailable`.
import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { asc, eq, sql } from 'drizzle-orm'
import { proxies, type Database } from '@wsm/db'
import type { ProxyRow } from './service'

export interface ProxyUnavailableEvent {
  proxyId: string
  error: string
  errorCount: number
  checkedAt: Date
}

export interface ProxyCheckResult {
  proxyId: string
  available: boolean
  error?: string
}

/** Resolve = proxy acessível; rejeita = indisponível (mensagem vira `last_error`). */
export type ProxyProbe = (proxy: ProxyRow) => Promise<unknown>

/** Logger mínimo (compatível com pino). */
export interface CheckerLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface ProxyCheckerOptions {
  db: Database
  probe?: ProxyProbe
  /** Intervalo entre rodadas em ms (default 60 000). */
  intervalMs?: number
  /** Timeout do probe TCP padrão em ms (default 5 000). */
  timeoutMs?: number
  logger?: CheckerLogger
}

/** Probe padrão: abre conexão TCP em host:port com timeout. */
export function tcpProbe(timeoutMs = 5000): ProxyProbe {
  return (proxy) =>
    new Promise<void>((resolve, reject) => {
      const socket = connect({ host: proxy.host.replace(/^\[|\]$/g, ''), port: proxy.port })
      const fail = (err: Error) => {
        socket.destroy()
        reject(err)
      }
      socket.setTimeout(timeoutMs, () => fail(new Error(`timeout after ${timeoutMs}ms connecting to ${proxy.host}:${proxy.port}`)))
      socket.once('error', fail)
      socket.once('connect', () => {
        socket.end()
        resolve()
      })
    })
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)) || 'unknown error'

/** Proxy respondeu na checagem (emitido a cada checagem bem-sucedida, não só na recuperação). */
export interface ProxyAvailableEvent {
  proxyId: string
  checkedAt: Date
}

export class ProxyChecker extends EventEmitter<{ proxy_unavailable: [ProxyUnavailableEvent]; proxy_available: [ProxyAvailableEvent] }> {
  private readonly probe: ProxyProbe
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | undefined
  private running: Promise<ProxyCheckResult[]> | undefined

  constructor(private readonly opts: ProxyCheckerOptions) {
    super()
    this.probe = opts.probe ?? tcpProbe(opts.timeoutMs)
    this.intervalMs = opts.intervalMs ?? 60_000
  }

  /**
   * Checa um proxy e grava `available`, `last_check_at`, `last_error` e `error_count`
   * (falhas consecutivas: +1 por falha, zera no sucesso).
   */
  async checkOne(proxy: ProxyRow): Promise<ProxyCheckResult> {
    const checkedAt = new Date()
    try {
      await this.probe(proxy)
    } catch (err) {
      const error = errorMessage(err)
      const [row] = await this.opts.db
        .update(proxies)
        .set({ available: false, lastCheckAt: checkedAt, lastError: error, errorCount: sql`${proxies.errorCount} + 1` })
        .where(eq(proxies.id, proxy.id))
        .returning({ errorCount: proxies.errorCount })
      if (!row) return { proxyId: proxy.id, available: false, error } // removido durante a checagem
      this.opts.logger?.warn({ proxyId: proxy.id, error, errorCount: row.errorCount }, 'proxy_unavailable')
      this.emit('proxy_unavailable', { proxyId: proxy.id, error, errorCount: row.errorCount, checkedAt })
      return { proxyId: proxy.id, available: false, error }
    }
    await this.opts.db
      .update(proxies)
      .set({ available: true, lastCheckAt: checkedAt, lastError: null, errorCount: 0 })
      .where(eq(proxies.id, proxy.id))
    this.emit('proxy_available', { proxyId: proxy.id, checkedAt })
    return { proxyId: proxy.id, available: true }
  }

  /** Checa todos os proxies em paralelo. Rodadas concorrentes são coalescidas. */
  checkAll(): Promise<ProxyCheckResult[]> {
    this.running ??= (async () => {
      try {
        const rows = await this.opts.db.select().from(proxies).orderBy(asc(proxies.createdAt))
        return await Promise.all(rows.map((p) => this.checkOne(p)))
      } finally {
        this.running = undefined
      }
    })()
    return this.running
  }

  /** Inicia as rodadas periódicas (a primeira roda imediatamente). */
  start(): void {
    if (this.timer) return
    const tick = () => {
      this.checkAll().catch((err: unknown) => this.opts.logger?.error({ err }, 'proxy check round failed'))
    }
    tick()
    this.timer = setInterval(tick, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}

export function createProxyChecker(opts: ProxyCheckerOptions): ProxyChecker {
  return new ProxyChecker(opts)
}
