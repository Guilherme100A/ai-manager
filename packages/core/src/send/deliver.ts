// Ponto ÚNICO de entrega ao transporte (SPEC 1.4 #2, AC-T08-06, AC-T09-04). Todo envio efetivo passa
// pelo AntibanAdapter (AC-T09-03): beforeSend → espera delayMs → transport.sendMessage → afterSend.
// 403 no envio → sinal forbidden_403 ao Health Monitor e redução automática dos limites da sessão.
import { defaultAntibanAdapter, type AntibanAdapter } from '../antiban/adapter'
import type { OutgoingContent, WaTransport } from '../transport'

/** Dados da mensagem que mudam a entrega. */
export interface DeliverMeta {
  /** `crm`: envio da ponte do CRM, que não passa pelo antiban (limites, idênticas, atrasos) nem entra nas contas dele. */
  origin?: string | null
}

/** Assinatura da entrega: injetável na fila (spies em teste, wrapper do T09 em produção). */
export type DeliverFn = (transport: WaTransport, to: string, content: OutgoingContent, meta?: DeliverMeta) => Promise<{ messageId: string }>

/** Destino dos sinais de saúde (HealthMonitor do T10). */
export interface HealthSignalSink {
  recordSignal(sessionId: string, type: 'forbidden_403', detail?: Record<string, unknown>): Promise<unknown> | unknown
}

/** Redução automática de limites (SessionLimitsService). */
export interface LimitReducer {
  reduce(sessionId: string, factor: number, reason: string): Promise<unknown> | unknown
}

export interface DeliverLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface CreateDeliverOptions {
  /** Adapter (default: o adapter padrão do processo, lido do ambiente a cada chamada). */
  antiban?: AntibanAdapter | (() => AntibanAdapter)
  /** Espera do delay do antiban (injetável em testes). */
  sleep?: (ms: number) => Promise<void>
  health?: HealthSignalSink
  limits?: LimitReducer
  /** Fator aplicado aos limites após um 403. Default 0.5. */
  forbiddenReduction?: number
  /** Resolve a sessão dona do transporte. Default: registro bindTransportSession → `transport.lastConnect.sessionId`. */
  sessionIdOf?: (transport: WaTransport) => string | undefined
  logger?: DeliverLogger
}

export const UNKNOWN_SESSION_KEY = '<unknown>'

export class AntibanBlockedError extends Error {
  readonly code = 'ANTIBAN_BLOCKED'
  constructor(
    readonly reason: string | undefined,
    readonly delayMs: number,
  ) {
    super(`blocked by antiban${reason ? `: ${reason}` : ''}`)
    this.name = 'AntibanBlockedError'
  }
}

const transportSessions = new WeakMap<WaTransport, string>()

/** Associa um transporte à sua sessão (para o antiban por sessão e os sinais de saúde). */
export function bindTransportSession(transport: WaTransport, sessionId: string): void {
  transportSessions.set(transport, sessionId)
}

export function defaultSessionIdOf(transport: WaTransport): string | undefined {
  const bound = transportSessions.get(transport)
  if (bound) return bound
  const last = (transport as { lastConnect?: { sessionId?: unknown } }).lastConnect
  return typeof last?.sessionId === 'string' ? last.sessionId : undefined
}

/** Erro de envio que indica 403 (conta restrita/bloqueada pelo WhatsApp). */
export function isForbiddenError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { statusCode?: unknown; status?: unknown; code?: unknown; reason?: unknown; output?: { statusCode?: unknown }; data?: { statusCode?: unknown } }
  return (
    e.statusCode === 403 ||
    e.status === 403 ||
    e.output?.statusCode === 403 ||
    e.data?.statusCode === 403 ||
    e.code === 'forbidden' ||
    e.code === 403 ||
    e.reason === 'forbidden'
  )
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function createDeliver(opts: CreateDeliverOptions = {}): DeliverFn {
  const resolveAdapter = (): AntibanAdapter =>
    typeof opts.antiban === 'function' ? opts.antiban() : (opts.antiban ?? defaultAntibanAdapter())
  const sleep = opts.sleep ?? defaultSleep
  const sessionIdOf = opts.sessionIdOf ?? defaultSessionIdOf

  return async (transport, to, content, meta) => {
    const antiban = resolveAdapter()
    const sessionId = sessionIdOf(transport)
    const key = sessionId ?? UNKNOWN_SESSION_KEY
    // Envio do CRM: fora do antiban (o fluxo do CRM já tem os próprios atrasos). O `sleep` ainda roda porque é
    // nele que o worker grava a marca de envio em curso; o 403 continua indo para o health e os limites.
    const viaAntiban = meta?.origin !== 'crm'
    if (viaAntiban) {
      const decision = await antiban.beforeSend(key, to, content)
      if (!decision.allowed) throw new AntibanBlockedError(decision.reason, decision.delayMs)
      if (decision.delayMs > 0) await sleep(decision.delayMs)
    } else await sleep(1)

    let result: { messageId: string }
    try {
      result = await transport.sendMessage(to, content)
    } catch (err) {
      if (viaAntiban) antiban.afterSendFailed(key, errorMessage(err))
      if (isForbiddenError(err) && sessionId) await reportForbidden(opts, sessionId, err)
      throw err
    }
    if (viaAntiban) antiban.afterSend(key, to, content, result.messageId)
    return result
  }
}

async function reportForbidden(opts: CreateDeliverOptions, sessionId: string, err: unknown): Promise<void> {
  const detail = { source: 'send', error: errorMessage(err) }
  try {
    await opts.health?.recordSignal(sessionId, 'forbidden_403', detail)
  } catch (e) {
    opts.logger?.error({ session_id: sessionId, err: errorMessage(e) }, 'failed to record forbidden_403 signal')
  }
  try {
    await opts.limits?.reduce(sessionId, opts.forbiddenReduction ?? 0.5, 'forbidden_403 on send')
  } catch (e) {
    opts.logger?.warn({ session_id: sessionId, err: errorMessage(e) }, 'failed to reduce limits after 403')
  }
}

/** Entrega padrão: sempre passa pelo AntibanAdapter padrão do processo (ANTIBAN_MODE, default real). */
export const deliver: DeliverFn = createDeliver()
