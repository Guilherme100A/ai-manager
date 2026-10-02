// Fila de mensagens por sessão (T08): uma fila BullMQ `session:<id>` por sessão, concorrência 1.
// A entrega ao transporte passa SEMPRE por `send/deliver` (AC-T08-06), injetável para o T09.
import { EventEmitter } from 'node:events'
import { Queue, UnrecoverableError, WaitingError, Worker, type ConnectionOptions, type Job } from 'bullmq'
import type { Database } from '@wsm/db'
import { deliver as defaultDeliver, type DeliverFn } from '../send/deliver'
import { SENDABLE_STATES } from '../session'
import type { OutgoingContent, ReceiptUpdate, WaTransport } from '../transport'
import { phoneToJid } from './jid'
import { CANCELLABLE_STATUSES, type MessageStatus } from './states'
import {
  MessageStore,
  toMessageEventView,
  toMessageView,
  type EnqueueMessageInput,
  type ListMessagesFilter,
  type MessageEventView,
  type MessageRow,
  type MessageTransitionOptions,
  type MessageView,
} from './store'

/** Controle da fila por sessão (usado pelo Health Monitor/T10 e pelo SessionManager). */
export interface SessionQueueControl {
  pause(sessionId: string): Promise<void>
  resume(sessionId: string): Promise<void>
}

/** Operações de mensagens expostas à API (`/api/messages`). */
export interface MessagesControl {
  get(id: string): Promise<MessageView>
  list(filter?: ListMessagesFilter): Promise<MessageView[]>
  events(id: string): Promise<MessageEventView[]>
  cancel(id: string): Promise<MessageView>
}

export type TransportProvider = (sessionId: string) => WaTransport | undefined

export interface MessageQueueLogger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

/** `{ url: 'redis://…' }` ou opções do ioredis (`{ host, port, … }`). */
export type RedisConnectionInput = { url: string } | ConnectionOptions

export interface MessageQueueOptions {
  db: Database
  /** Default: `REDIS_URL` ou `redis://localhost:6379`. */
  connection?: RedisConnectionInput
  /** Prefixo das chaves no Redis (isole testes com um prefixo aleatório). Default `wsm`. */
  prefix?: string
  /** Transporte vivo da sessão (conectado); `undefined` → a mensagem espera na fila. */
  getTransport?: TransportProvider
  /** Ponto de entrega (default `deliver` de send/deliver.ts). */
  deliver?: DeliverFn
  /** Tentativas de envio (AC-T08-03). Default 3. */
  maxAttempts?: number
  /** Base do backoff exponencial entre tentativas: base·2^(n-1). Default 1000 ms. */
  backoffDelayMs?: number
  /** Espera antes de reavaliar uma sessão que não pode enviar agora. Default 2000 ms. */
  holdDelayMs?: number
  /** Se false, só produz (enfileira) e não cria Workers — ex.: processo da API. Default true. */
  consume?: boolean
  logger?: MessageQueueLogger
  now?: () => Date
}

export interface MessageStatusEvent {
  messageId: string
  sessionId: string
  from: MessageStatus | null
  to: MessageStatus
}

export interface MessageQueueEvents {
  status: [MessageStatusEvent]
  error: [Error]
}

interface JobData {
  messageId: string
}

export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_BACKOFF_DELAY_MS = 1000
export const DEFAULT_HOLD_DELAY_MS = 2000
const PENDING_RECEIPT_TTL_MS = 60_000
const PENDING_RECEIPT_MAX = 1000

/** Nome lógico da fila da sessão (AC-T08-01). */
export function queueName(sessionId: string): string {
  return `session:${sessionId}`
}

/** Converte `{ url }` em opções do ioredis; demais formatos passam direto. */
export function toConnectionOptions(input?: RedisConnectionInput): ConnectionOptions {
  const value = input ?? { url: process.env.REDIS_URL ?? 'redis://localhost:6379' }
  if (!('url' in value) || typeof value.url !== 'string') return value as ConnectionOptions
  const u = new URL(value.url)
  const opts: Record<string, unknown> = { host: u.hostname || 'localhost', port: u.port ? Number(u.port) : 6379 }
  if (u.username) opts.username = decodeURIComponent(u.username)
  if (u.password) opts.password = decodeURIComponent(u.password)
  const db = u.pathname.replace(/^\//, '')
  if (db) opts.db = Number(db)
  if (u.protocol === 'rediss:') opts.tls = {}
  return opts as ConnectionOptions
}

const noopLogger: MessageQueueLogger = { debug() {}, info() {}, warn() {}, error() {} }

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class MessageQueue extends EventEmitter<MessageQueueEvents> implements SessionQueueControl, MessagesControl {
  readonly store: MessageStore
  private readonly connection: ConnectionOptions
  /** BullMQ proíbe `:` no nome da fila: o prefixo leva `session` e o nome é o id → chave `<prefix>:session:<id>`. */
  private readonly bullPrefix: string
  private readonly queues = new Map<string, { queue: Queue<JobData>; ready: Promise<void> }>()
  private readonly workers = new Map<string, Promise<Worker<JobData>>>()
  private readonly controlChains = new Map<string, Promise<unknown>>()
  private readonly controlVersions = new Map<string, number>()
  /** Esperas de hold em curso (acordadas no close). */
  private readonly sleepers = new Set<() => void>()
  private readonly pendingReceipts = new Map<string, { sessionId: string; statuses: ReceiptUpdate['status'][]; at: number }>()
  private readonly log: MessageQueueLogger
  private readonly deliverFn: DeliverFn
  private readonly maxAttempts: number
  private readonly backoffDelayMs: number
  private readonly holdDelayMs: number
  private readonly now: () => Date
  private transportProvider: TransportProvider | undefined
  private closed = false

  constructor(private readonly opts: MessageQueueOptions) {
    super()
    this.store = new MessageStore(opts.db)
    this.connection = toConnectionOptions(opts.connection)
    this.bullPrefix = `${opts.prefix ?? 'wsm'}:session`
    this.log = opts.logger ?? noopLogger
    this.deliverFn = opts.deliver ?? defaultDeliver
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.backoffDelayMs = opts.backoffDelayMs ?? DEFAULT_BACKOFF_DELAY_MS
    this.holdDelayMs = opts.holdDelayMs ?? DEFAULT_HOLD_DELAY_MS
    this.now = opts.now ?? (() => new Date())
    this.transportProvider = opts.getTransport
    // Sem listener, `emit('error')` derrubaria o processo.
    this.on('error', () => {})
  }

  queueName(sessionId: string): string {
    return queueName(sessionId)
  }

  /** Chave base da fila no Redis (`<prefix>:session:<id>`). */
  redisKey(sessionId: string): string {
    return `${this.bullPrefix}:${sessionId}`
  }

  /** Define/substitui o provedor de transporte (o worker liga ao SessionManager). */
  setTransportProvider(provider: TransportProvider | undefined): void {
    this.transportProvider = provider
  }

  // ---- produção ---------------------------------------------------------------------

  /** Grava a mensagem `queued` (+ message_event) e adiciona o job `jobId = messageId` na fila da sessão. */
  async enqueue(input: EnqueueMessageInput): Promise<MessageView> {
    this.assertOpen()
    const row = await this.store.create(input)
    this.emitStatus({ messageId: row.id, sessionId: row.sessionId, from: null, to: 'queued' })
    try {
      const queue = await this.queue(row.sessionId)
      await queue.add(
        'send',
        { messageId: row.id },
        {
          jobId: row.id,
          attempts: this.maxAttempts,
          backoff: { type: 'exponential', delay: this.backoffDelayMs },
          removeOnComplete: true,
          removeOnFail: 1000,
        },
      )
    } catch (err) {
      await this.transition(row.id, 'failed', { from: ['queued'], set: { error: `enqueue failed: ${errorMessage(err)}` } }, false)
      throw err
    }
    if (this.opts.consume !== false) await this.startSession(row.sessionId)
    return toMessageView(await this.store.get(row.id))
  }

  // ---- controle -------------------------------------------------------------------------

  /**
   * Pausa a fila da sessão: jobs ficam em espera (status `queued`) até o resume (AC-T08-05).
   * Idempotente e durável (o estado de pausa fica no Redis); vale antes ou depois de o Worker existir.
   */
  pause(sessionId: string): Promise<void> {
    this.assertOpen()
    this.bumpControl(sessionId)
    return this.control(sessionId, async () => {
      await (await this.queue(sessionId)).pause()
      this.log.info({ session_id: sessionId }, 'message queue paused')
    })
  }

  /**
   * Retoma a fila da sessão; os jobs voltam a ser processados na ordem de entrada.
   * Único caminho que retoma a fila (chamado explicitamente ou na saída de PAUSED). Idempotente.
   */
  resume(sessionId: string): Promise<void> {
    this.assertOpen()
    this.bumpControl(sessionId)
    return this.control(sessionId, async () => {
      await (await this.queue(sessionId)).resume()
      this.log.info({ session_id: sessionId }, 'message queue resumed')
    })
  }

  /** Cada pause/resume explícito gera uma versão nova: pausas automáticas mais antigas são descartadas. */
  private bumpControl(sessionId: string): number {
    const v = (this.controlVersions.get(sessionId) ?? 0) + 1
    this.controlVersions.set(sessionId, v)
    return v
  }

  /** Serializa pause/resume da sessão: a última chamada sempre vence, na ordem em que foram feitas. */
  private control(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.controlChains.get(sessionId) ?? Promise.resolve()).then(fn)
    this.controlChains.set(sessionId, run.catch(() => undefined))
    return run
  }

  async isPaused(sessionId: string): Promise<boolean> {
    return (await this.queue(sessionId)).isPaused()
  }

  /** Cancela uma mensagem `queued`/`retrying` (AC-T08-04). Ela nunca chega ao transporte. */
  async cancel(id: string): Promise<MessageView> {
    const res = await this.transition(id, 'cancelled', { from: CANCELLABLE_STATUSES }, true)
    // O processador também ignora mensagens fora de queued/retrying; remover o job é só limpeza.
    try {
      await (await this.queue(res!.row.sessionId)).remove(id)
    } catch (err) {
      this.log.debug({ message_id: id, err: errorMessage(err) }, 'job removal skipped')
    }
    return toMessageView(res!.row)
  }

  async get(id: string): Promise<MessageView> {
    return toMessageView(await this.store.get(id))
  }

  async list(filter: ListMessagesFilter = {}): Promise<MessageView[]> {
    return (await this.store.list(filter)).map(toMessageView)
  }

  async events(id: string): Promise<MessageEventView[]> {
    await this.store.get(id)
    return (await this.store.events(id)).map(toMessageEventView)
  }

  // ---- consumo ------------------------------------------------------------------------------

  /** Cria (uma vez) o Worker da sessão com concorrência 1, sincronizando a pausa com o estado no banco. */
  startSession(sessionId: string): Promise<void> {
    this.assertOpen()
    let worker = this.workers.get(sessionId)
    if (!worker) {
      worker = this.createWorker(sessionId)
      this.workers.set(sessionId, worker)
      worker.catch(() => this.workers.delete(sessionId))
    }
    return worker.then(() => undefined)
  }

  /**
   * Sessão excluída: fecha o Worker da sessão (espera o envio em curso) e apaga a fila dela no Redis.
   * As linhas de mensagens já saíram do banco em cascata; nada mais será entregue por essa sessão.
   */
  async removeSession(sessionId: string): Promise<void> {
    const worker = this.workers.get(sessionId)
    this.workers.delete(sessionId)
    if (worker) await worker.then((w) => w.close()).catch(() => undefined)
    const queue = await this.queue(sessionId)
    try {
      await queue.obliterate({ force: true })
    } finally {
      this.queues.delete(sessionId)
      this.controlChains.delete(sessionId)
      this.controlVersions.delete(sessionId)
      for (const [id, pending] of this.pendingReceipts) if (pending.sessionId === sessionId) this.pendingReceipts.delete(id)
      await queue.close().catch(() => undefined)
    }
    this.log.info({ session_id: sessionId }, 'message queue removed')
  }

  /** Receipt do transporte (AC-T08-02): sent → delivered → read. Casa por `transport_message_id`. */
  async handleReceipt(sessionId: string, receipt: ReceiptUpdate): Promise<void> {
    const row = await this.store.findByTransportId(sessionId, receipt.messageId)
    if (!row) {
      // O receipt pode chegar antes de gravarmos `sent`: guarda e aplica logo após o envio.
      this.bufferReceipt(sessionId, receipt)
      return
    }
    await this.applyReceipt(row.id, receipt.status)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const wake of this.sleepers) wake()
    this.sleepers.clear()
    const workers = await Promise.allSettled([...this.workers.values()])
    await Promise.allSettled(workers.map((w) => (w.status === 'fulfilled' ? w.value.close() : undefined)))
    await Promise.allSettled([...this.queues.values()].map(async (q) => q.queue.close()))
    this.workers.clear()
    this.queues.clear()
    this.controlChains.clear()
    this.pendingReceipts.clear()
  }

  // ---- internos -------------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new Error('message queue is closed')
  }

  private async queue(sessionId: string): Promise<Queue<JobData>> {
    let entry = this.queues.get(sessionId)
    if (!entry) {
      const queue = new Queue<JobData>(sessionId, { connection: this.connection, prefix: this.bullPrefix })
      queue.on('error', (err) => this.log.error({ session_id: sessionId, err: err.message }, 'queue error'))
      // Concorrência 1 também entre processos (AC-T08-01).
      const ready = queue.setGlobalConcurrency(1).then(() => undefined)
      entry = { queue, ready }
      this.queues.set(sessionId, entry)
    }
    await entry.ready
    return entry.queue
  }

  private async createWorker(sessionId: string): Promise<Worker<JobData>> {
    await this.queue(sessionId)
    // Nunca retoma aqui: uma pausa explícita (SessionQueueControl) só é desfeita por resume().
    // Sessão PAUSED no boot pausa a fila, a menos que um pause/resume explícito tenha chegado depois da leitura.
    const version = this.controlVersions.get(sessionId) ?? 0
    if ((await this.store.sessionStatus(sessionId)) === 'PAUSED') {
      await this.control(sessionId, async () => {
        if ((this.controlVersions.get(sessionId) ?? 0) !== version) return
        await (await this.queue(sessionId)).pause()
      })
    }
    const worker = new Worker<JobData>(sessionId, (job, token) => this.process(sessionId, job, token), {
      connection: this.connection,
      prefix: this.bullPrefix,
      concurrency: 1,
      // Falha ao buscar o próximo job (Redis instável): tenta de novo logo, não em 15 s (default do BullMQ).
      runRetryDelay: 1000,
    })
    worker.on('error', (err) => this.log.error({ session_id: sessionId, err: err.message }, 'queue worker error'))
    return worker
  }

  /** Processa um job: confere a sessão, reivindica a mensagem e entrega pelo ponto único. */
  private async process(sessionId: string, job: Job<JobData>, token?: string): Promise<void> {
    const { messageId } = job.data
    const ready = await this.waitUntilSendable(sessionId, messageId, job, token)
    if (!ready) return
    const { msg, transport } = ready

    const claimed = await this.transition(
      messageId,
      'processing',
      { from: CANCELLABLE_STATUSES, set: (row) => ({ attempts: row.attempts + 1 }), detail: { attempt: msg.attempts + 1 } },
      false,
    )
    if (!claimed) return
    const attempt = claimed.row.attempts

    let transportMessageId: string
    try {
      const res = await this.deliverFn(transport, phoneToJid(claimed.row.phone), claimed.row.content as OutgoingContent)
      transportMessageId = res.messageId
    } catch (err) {
      const error = errorMessage(err)
      if (attempt >= this.maxAttempts) {
        await this.transition(messageId, 'failed', { from: ['processing'], set: { error }, detail: { attempt, error } }, false)
        this.log.warn({ session_id: sessionId, message_id: messageId, attempt }, 'message failed')
        throw new UnrecoverableError(error)
      }
      await this.transition(messageId, 'retrying', { from: ['processing'], set: { error }, detail: { attempt, error } }, false)
      this.log.info({ session_id: sessionId, message_id: messageId, attempt }, 'message send failed, retrying')
      throw err instanceof Error ? err : new Error(error)
    }

    // Fora do try: uma falha ao gravar `sent` não pode provocar reenvio (a mensagem fica em processing).
    await this.transition(
      messageId,
      'sent',
      { from: ['processing'], set: { transportMessageId, sentAt: this.now(), error: null }, detail: { attempt, transportMessageId } },
      false,
    )
    await this.flushPendingReceipts(sessionId, messageId, transportMessageId)
  }

  /**
   * Segura o job (ativo, mensagem ainda `queued`) até a sessão poder enviar: status WARMING/STABLE no banco
   * (defesa, mesmo sem o evento de pausa), fila não pausada e transporte conectado. A ordem FIFO se mantém
   * porque a concorrência é 1. Não pausa a fila por conta própria: só pause()/resume() mexem nela.
   * Devolve undefined se a mensagem não deve mais ser enviada (cancelada, removida ou sessão inexistente).
   */
  private async waitUntilSendable(
    sessionId: string,
    messageId: string,
    job: Job<JobData>,
    token: string | undefined,
  ): Promise<{ msg: MessageRow; transport: WaTransport } | undefined> {
    let lastReason: string | undefined
    for (;;) {
      if (this.closed) {
        // Encerrando: devolve o job para a espera sem contar tentativa.
        await job.moveToWait(token)
        throw new WaitingError()
      }
      const msg = await this.store.find(messageId)
      // Cancelada, já enviada ou removida: nunca vai ao transporte.
      if (!msg || !CANCELLABLE_STATUSES.includes(msg.status)) return undefined
      const status = await this.store.sessionStatus(sessionId)
      if (!status) {
        await this.transition(messageId, 'failed', { from: CANCELLABLE_STATUSES, set: { error: 'session not found' } }, false)
        return undefined
      }
      let reason: string | undefined
      let transport: WaTransport | undefined
      if (!SENDABLE_STATES.includes(status)) reason = `session ${status}`
      else if (await (await this.queue(sessionId)).isPaused()) reason = 'queue paused'
      else if (!(transport = this.transportProvider?.(sessionId))) reason = 'transport not connected'
      if (transport && !reason) return { msg, transport }
      if (reason !== lastReason) this.log.debug({ session_id: sessionId, message_id: messageId, reason }, 'message held in queue')
      lastReason = reason
      await this.sleepHold()
    }
  }

  private sleepHold(): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.sleepers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, this.holdDelayMs)
      this.sleepers.add(wake)
    })
  }

  private async transition(
    id: string,
    to: MessageStatus,
    opts: MessageTransitionOptions,
    strict: boolean,
  ): Promise<{ row: Awaited<ReturnType<MessageStore['get']>>; from: MessageStatus; to: MessageStatus } | null> {
    const res = strict ? await this.store.transition(id, to, opts) : await this.store.tryTransition(id, to, opts)
    if (res) this.emitStatus({ messageId: id, sessionId: res.row.sessionId, from: res.from, to: res.to })
    return res
  }

  private emitStatus(ev: MessageStatusEvent): void {
    try {
      this.emit('status', ev)
    } catch (err) {
      this.log.error({ message_id: ev.messageId, err: errorMessage(err) }, 'status listener failed')
    }
  }

  private async applyReceipt(messageId: string, status: ReceiptUpdate['status']): Promise<void> {
    const at = this.now()
    if (status === 'delivered') {
      await this.transition(messageId, 'delivered', { from: ['sent'], set: { deliveredAt: at } }, false)
      return
    }
    // read sem delivered antes: registra delivered implícito para manter a sequência.
    await this.transition(messageId, 'delivered', { from: ['sent'], set: { deliveredAt: at }, detail: { implied: true } }, false)
    await this.transition(messageId, 'read', { from: ['delivered'], set: { readAt: at } }, false)
  }

  private bufferReceipt(sessionId: string, receipt: ReceiptUpdate): void {
    const cutoff = Date.now() - PENDING_RECEIPT_TTL_MS
    for (const [k, v] of this.pendingReceipts) if (v.at < cutoff) this.pendingReceipts.delete(k)
    if (this.pendingReceipts.size >= PENDING_RECEIPT_MAX) return
    const entry = this.pendingReceipts.get(receipt.messageId) ?? { sessionId, statuses: [], at: Date.now() }
    entry.statuses.push(receipt.status)
    this.pendingReceipts.set(receipt.messageId, entry)
  }

  private async flushPendingReceipts(sessionId: string, messageId: string, transportMessageId: string): Promise<void> {
    const entry = this.pendingReceipts.get(transportMessageId)
    if (!entry || entry.sessionId !== sessionId) return
    this.pendingReceipts.delete(transportMessageId)
    for (const status of entry.statuses) await this.applyReceipt(messageId, status)
  }
}
