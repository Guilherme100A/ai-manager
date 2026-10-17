// Outbox de eventos (integração CRM, A1; só com CRM_BRIDGE=on): o que acontece nas sessões vira WaEvent v1 no Redis
// Stream `wsm:events` (XADD <stream> MAXLEN ~ 100000 * event <json>), que o CRM em modo extensão consome.
// Publica session.state, session.connection, session.qr, session.pairing_code, message.inbound e message.status.
// - Ordem: uma cadeia por sessão; cada evento entra no buffer depois dos anteriores da mesma sessão.
// - Redis fora do ar não derruba nada: os eventos ficam num buffer FIFO limitado e o publicador tenta de novo.
// - Só escuta (manager, fila, transportes): não muda nenhum fluxo do ai-manager.
import type { DisconnectKind, IncomingMessage, MessageStatusEvent, SessionState, WaTransport } from '@wsm/core'
import { toQrDataUrl } from '../sessions/qr'
import { assertWaEvent, toWaMessage, WA_EVENT_VERSION, WA_EVENTS_STREAM, type WaEvent } from './wa-event'

export const DEFAULT_OUTBOX_MAXLEN = 100_000
export const DEFAULT_OUTBOX_RETRY_MS = 1000
export const DEFAULT_OUTBOX_BUFFER_LIMIT = 10_000
/** Campo da entrada do stream (o consumidor do CRM lê `event`). */
export const OUTBOX_EVENT_FIELD = 'event'

/** Parte do SessionManager que o outbox escuta. */
export interface OutboxManager {
  on(event: 'connected', cb: (ctx: { sessionId: string; transport: WaTransport }) => void): unknown
  on(event: 'disconnected', cb: (ctx: { sessionId: string; reason: DisconnectKind | 'local'; statusCode?: number }) => void): unknown
  on(event: 'state', cb: (ev: { sessionId: string; from: SessionState; to: SessionState }) => void): unknown
  on(event: 'qr', cb: (ev: { sessionId: string; qr: string }) => void): unknown
  on(event: 'pairing-code', cb: (ev: { sessionId: string; code: string }) => void): unknown
  off(event: string, cb: (...args: never[]) => void): unknown
}

/** Parte da MessageQueue usada para `message.status`. */
export interface OutboxQueue {
  on(event: 'status', cb: (ev: MessageStatusEvent) => void): unknown
  off(event: 'status', cb: (ev: MessageStatusEvent) => void): unknown
  get(id: string): Promise<{ transportMessageId: string | null; lastError: string | null }>
}

/** Só o XADD é usado (ioredis ou fake nos testes). */
export interface OutboxRedis {
  xadd(...args: (string | number)[]): Promise<unknown>
}

export interface OutboxLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface EventOutboxOptions {
  stream?: string
  maxLen?: number
  retryMs?: number
  /** Máximo de eventos em espera; acima disso os mais antigos são descartados (com log). */
  bufferLimit?: number
  logger?: OutboxLogger
  now?: () => Date
  /** QR → data URL (default: o mesmo PNG do painel). */
  qrDataUrl?: (qr: string) => Promise<string>
}

export interface EventOutbox {
  /** Remove os listeners (manager, fila e transportes). O que já está no buffer continua sendo publicado. */
  detach(): void
  /** Espera publicar tudo o que já foi capturado. */
  flush(): Promise<void>
  /** Eventos no buffer, ainda não confirmados pelo Redis. */
  readonly pending: number
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function attachEventOutbox(manager: OutboxManager, queue: OutboxQueue | undefined, redis: OutboxRedis, opts: EventOutboxOptions = {}): EventOutbox {
  const stream = opts.stream ?? WA_EVENTS_STREAM
  const maxLen = opts.maxLen ?? DEFAULT_OUTBOX_MAXLEN
  const retryMs = opts.retryMs ?? DEFAULT_OUTBOX_RETRY_MS
  const bufferLimit = opts.bufferLimit ?? DEFAULT_OUTBOX_BUFFER_LIMIT
  const now = opts.now ?? (() => new Date())
  const qrDataUrl = opts.qrDataUrl ?? toQrDataUrl
  const log = opts.logger

  // ---- publicação (buffer FIFO + retry) ----------------------------------------------------
  const buffer: string[] = []
  let draining: Promise<void> | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let detached = false
  const idleWaiters: (() => void)[] = []

  const enqueueEvent = (event: WaEvent) => {
    try {
      assertWaEvent(event)
    } catch (err) {
      log?.error({ type: event.type, session_id: event.session_id, err: errorMessage(err) }, 'WaEvent inválido descartado')
      return
    }
    buffer.push(JSON.stringify(event))
    if (buffer.length > bufferLimit) {
      const dropped = buffer.splice(0, buffer.length - bufferLimit)
      log?.error({ dropped: dropped.length }, 'buffer do outbox cheio: eventos mais antigos descartados')
    }
    drain()
  }

  const drain = () => {
    if (draining || retryTimer) return
    draining = (async () => {
      while (buffer.length > 0) {
        try {
          await redis.xadd(stream, 'MAXLEN', '~', maxLen, '*', OUTBOX_EVENT_FIELD, buffer[0]!)
          buffer.shift()
        } catch (err) {
          log?.warn({ pending: buffer.length, err: errorMessage(err) }, 'Redis indisponível: eventos do outbox em espera')
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            drain()
          }, retryMs)
          retryTimer.unref?.()
          return
        }
      }
      for (const wake of idleWaiters.splice(0)) wake()
    })().finally(() => {
      draining = undefined
    })
  }

  // ---- ordem por sessão ----------------------------------------------------------------------
  const chains = new Map<string, Promise<void>>()
  const inSession = (sessionId: string, produce: () => Promise<WaEvent | undefined> | WaEvent | undefined) => {
    const prev = chains.get(sessionId) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        const event = await produce()
        if (event) enqueueEvent(event)
      })
      .catch((err) => log?.error({ session_id: sessionId, err: errorMessage(err) }, 'falha ao montar evento do outbox'))
    chains.set(sessionId, next)
    void next.then(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId)
    })
  }
  const at = () => now().toISOString()
  const envelope = (sessionId: string) => ({ v: WA_EVENT_VERSION, session_id: sessionId, at: at() })

  // ---- transporte da sessão (mensagens recebidas) ------------------------------------------------
  const wired = new Map<string, { transport: WaTransport; unwire: () => void }>()
  const wire = (sessionId: string, transport: WaTransport) => {
    const current = wired.get(sessionId)
    if (current?.transport === transport) return
    current?.unwire()
    const onMessage = (msg: IncomingMessage) => {
      if (detached) return
      inSession(sessionId, () => ({ ...envelope(sessionId), type: 'message.inbound', message: toWaMessage(sessionId, msg) }))
    }
    transport.on('message', onMessage)
    wired.set(sessionId, {
      transport,
      // `off` é opcional na interface: sem ele, o `detached` acima silencia o listener.
      unwire: () => transport.off?.('message', onMessage),
    })
  }

  // ---- manager e fila ----------------------------------------------------------------------------
  const onConnected = (ctx: { sessionId: string; transport: WaTransport }) => {
    wire(ctx.sessionId, ctx.transport)
    inSession(ctx.sessionId, () => ({ ...envelope(ctx.sessionId), type: 'session.connection', state: 'open' }))
  }
  const onDisconnected = (ctx: { sessionId: string; reason: DisconnectKind | 'local'; statusCode?: number }) =>
    inSession(ctx.sessionId, () => {
      const event: WaEvent = { ...envelope(ctx.sessionId), type: 'session.connection', state: 'close' }
      if (ctx.reason !== 'local') event.reason = ctx.reason
      if (ctx.statusCode !== undefined) event.status_code = ctx.statusCode
      return event
    })
  const onState = (ev: { sessionId: string; from: SessionState; to: SessionState }) =>
    inSession(ev.sessionId, () => ({ ...envelope(ev.sessionId), type: 'session.state', from: ev.from ?? null, to: ev.to }))
  const onQr = (ev: { sessionId: string; qr: string }) =>
    inSession(ev.sessionId, async () => ({ ...envelope(ev.sessionId), type: 'session.qr', qr: await qrDataUrl(ev.qr) }))
  const onPairing = (ev: { sessionId: string; code: string }) =>
    inSession(ev.sessionId, () => ({ ...envelope(ev.sessionId), type: 'session.pairing_code', code: ev.code }))
  const onStatus = (ev: MessageStatusEvent) =>
    inSession(ev.sessionId, async () => {
      const view = await queue!.get(ev.messageId).catch(() => undefined)
      const event: WaEvent = {
        ...envelope(ev.sessionId),
        type: 'message.status',
        message_id: ev.messageId,
        transport_message_id: view?.transportMessageId ?? null,
        status: ev.to,
      }
      if (ev.to === 'failed' && view?.lastError) event.error = view.lastError
      return event
    })

  manager.on('connected', onConnected)
  manager.on('disconnected', onDisconnected)
  manager.on('state', onState)
  manager.on('qr', onQr)
  manager.on('pairing-code', onPairing)
  queue?.on('status', onStatus)

  return {
    detach() {
      if (detached) return
      detached = true
      manager.off('connected', onConnected as never)
      manager.off('disconnected', onDisconnected as never)
      manager.off('state', onState as never)
      manager.off('qr', onQr as never)
      manager.off('pairing-code', onPairing as never)
      queue?.off('status', onStatus)
      for (const w of wired.values()) w.unwire()
      wired.clear()
    },
    async flush() {
      for (;;) {
        const pendingChains = [...chains.values()]
        if (pendingChains.length === 0) break
        await Promise.all(pendingChains)
      }
      if (buffer.length === 0 && !draining) return
      await new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
        drain()
      })
    },
    get pending() {
      return buffer.length
    },
  }
}
