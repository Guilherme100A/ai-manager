// SessionManager (T05): cria, autentica, persiste, reconecta e controla sessões.
// Toda conexão passa por connectSession (T06): proxy configurado é obrigatório, sem fallback direto.
import { EventEmitter } from 'node:events'
import {
  assertAction,
  canTransition,
  connectSession,
  logger as coreLogger,
  ProxyError,
  SessionError,
  SessionStore,
  toSessionView,
  usePostgresAuthState,
  type CreateSessionInput,
  type PostgresAuthState,
  type SessionRow,
  type SessionState,
  type SessionView,
  type TransitionOptions,
  type WaTransport,
} from '@wsm/core'
import type { Database } from '@wsm/db'
import { toQrDataUrl } from './qr'

export interface SessionManagerLogger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export type TransportFactory = (sessionId: string) => WaTransport

export interface ConnectedContext {
  sessionId: string
  transport: WaTransport
  state: SessionState
}

export interface DisconnectedContext {
  sessionId: string
  reason: 'loggedOut' | 'forbidden' | 'transient' | 'local'
  statusCode?: number
}

export interface SessionManagerOptions {
  db: Database
  /** Cria o transporte de uma sessão (FakeTransport nos testes, BaileysTransport em produção). */
  transportFactory: TransportFactory
  logger?: SessionManagerLogger
  /** Espera entre reconexões (injetável para testes). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Atraso da tentativa `attempt` (1-based). Default: 1000·2^(attempt-1) → 1s, 2s, 4s, 8s, 16s. */
  backoff?: (attempt: number) => number
  /** Máximo de reconexões após queda transitória (AC-T05-05). Default 5. */
  maxReconnectAttempts?: number
  /** Hook de monitoramento (T10 pluga aqui): chamado a cada conexão aberta. */
  onConnected?: (sessionId: string, ctx: ConnectedContext) => void | Promise<void>
  /** Chamado quando a conexão cai ou é encerrada (para parar o monitoramento). */
  onDisconnected?: (sessionId: string, ctx: DisconnectedContext) => void | Promise<void>
  /** Estado de destino do resume manual (PAUSED → WARMING|STABLE). Default: WARMING (o warm-up promove a STABLE). */
  resumeState?: (row: SessionRow) => 'WARMING' | 'STABLE' | Promise<'WARMING' | 'STABLE'>
  /** Prazo para o transporte emitir o código de pareamento. Default 30s. */
  pairingTimeoutMs?: number
  /** Conta já pareada que não abre a conexão neste prazo: a tentativa vira queda transitória e entra no backoff. Default 60s. */
  connectTimeoutMs?: number
  /** Relógio (injetável). */
  now?: () => Date
  /** Auth state persistido (default: usePostgresAuthState, cifrado — T02). */
  authStateFactory?: (db: Database, sessionId: string) => Promise<PostgresAuthState>
}

export interface QrInfo {
  /** Data URL (image/png) do QR mais recente, ou null se ainda não houver. */
  qr: string | null
  generatedAt: string | null
}

export interface SessionRuntimeInfo {
  sessionId: string
  connected: boolean
  monitoring: boolean
  reconnectAttempts: number
  pairingPhone?: string
}

export type SessionManagerErrorCode = 'PAIRING_TIMEOUT' | 'CONNECTION_CLOSED'

export class SessionManagerError extends Error {
  constructor(
    readonly code: SessionManagerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SessionManagerError'
  }
}

interface Waiter {
  resolve: (code: string) => void
  reject: (err: Error) => void
}

interface Runtime {
  sessionId: string
  transport: WaTransport
  auth: PostgresAuthState
  pairingPhone?: string
  connected: boolean
  monitoring: boolean
  failures: number
  /** Encerramento local (logout/restart/stop): eventos de close são ignorados. */
  closing: boolean
  disposed: boolean
  qr?: { raw: string; at: Date; dataUrl: Promise<string> }
  pairingCode?: string
  pairingWaiters: Waiter[]
  chain: Promise<unknown>
  /** A primeira conexão já foi disparada. */
  started: boolean
  /** Conta as tentativas de conexão: o vigia só age sobre a tentativa que o armou. */
  attempt: number
}

export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000
export const defaultBackoff = (attempt: number) => 1000 * 2 ** (attempt - 1)

const noopLogger: SessionManagerLogger = { debug() {}, info() {}, warn() {}, error() {} }

export interface SessionManagerEvents {
  connected: [ConnectedContext]
  disconnected: [DisconnectedContext]
  state: [{ sessionId: string; from: SessionState; to: SessionState }]
  qr: [{ sessionId: string; qr: string }]
  'pairing-code': [{ sessionId: string; code: string }]
  reconnect: [{ sessionId: string; attempt: number; delayMs: number }]
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  readonly store: SessionStore
  private readonly runtimes = new Map<string, Runtime>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly timers = new Map<NodeJS.Timeout, () => void>()
  private readonly log: SessionManagerLogger
  private readonly maxAttempts: number
  private readonly connectTimeoutMs: number
  private readonly backoff: (attempt: number) => number
  private readonly now: () => Date
  private stopped = false

  constructor(private readonly opts: SessionManagerOptions) {
    super()
    this.store = new SessionStore(opts.db)
    this.log = opts.logger ?? safeChild(coreLogger) ?? noopLogger
    this.maxAttempts = opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.backoff = opts.backoff ?? defaultBackoff
    this.now = opts.now ?? (() => new Date())
  }

  // ---- ciclo de vida do worker ------------------------------------------------

  /** Boot (AC-T05-04): reconecta sessões com credenciais e estado ≠ DISCONNECTED (PAUSED continua PAUSED). */
  async start(): Promise<void> {
    this.stopped = false
    const rows = await this.store.listResumable()
    const results = await Promise.allSettled(rows.filter((r) => !this.runtimes.has(r.id)).map((r) => this.openRuntime(r.id)))
    for (const r of results) if (r.status === 'rejected') this.log.error({ err: r.reason }, 'session resume failed')
    this.log.info({ sessions: rows.length }, 'session manager started')
  }

  /** Fecha todos os transportes sem alterar o estado no banco (shutdown / restart do worker). */
  async stop(): Promise<void> {
    this.stopped = true
    for (const [timer, wake] of this.timers) {
      clearTimeout(timer)
      wake()
    }
    this.timers.clear()
    await Promise.allSettled([...this.runtimes.values()].map((rt) => this.dispose(rt, 'local')))
    await this.whenIdle()
  }

  /** Resolve quando não há tarefas pendentes (eventos de conexão, reconexões). Útil em testes. */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  // ---- consultas ------------------------------------------------------------------

  async create(input: CreateSessionInput): Promise<SessionView> {
    return toSessionView(await this.store.create(input))
  }

  async list(): Promise<SessionView[]> {
    return (await this.store.list()).map(toSessionView)
  }

  async get(id: string): Promise<SessionView> {
    return toSessionView(await this.store.get(id))
  }

  /** Transporte vivo da sessão (para fila/grupos), se houver. */
  getTransport(sessionId: string): WaTransport | undefined {
    return this.runtimes.get(sessionId)?.transport
  }

  isConnected(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.connected ?? false
  }

  isMonitoring(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.monitoring ?? false
  }

  runtimeInfo(sessionId: string): SessionRuntimeInfo | undefined {
    const rt = this.runtimes.get(sessionId)
    if (!rt) return undefined
    const info: SessionRuntimeInfo = {
      sessionId,
      connected: rt.connected,
      monitoring: rt.monitoring,
      reconnectAttempts: rt.failures,
    }
    if (rt.pairingPhone) info.pairingPhone = rt.pairingPhone
    return info
  }

  // ---- autenticação (AC-T05-02) -------------------------------------------------

  /** POST /qr: inicia a conexão (QR). Válido em NEW ou DISCONNECTED (DISCONNECTED → NEW). */
  async startQr(id: string): Promise<SessionView> {
    const row = await this.prepareAuth(id)
    const rt = this.runtimes.get(id)
    if (rt && !rt.pairingPhone) return toSessionView(row)
    if (rt) await this.dispose(rt, 'local')
    await this.openRuntime(id)
    return this.get(id)
  }

  async getQr(id: string): Promise<QrInfo> {
    await this.store.get(id)
    const qr = this.runtimes.get(id)?.qr
    if (!qr) return { qr: null, generatedAt: null }
    return { qr: await qr.dataUrl, generatedAt: qr.at.toISOString() }
  }

  /** POST /pairing-code: conecta pedindo código de pareamento para `phone` (default: telefone da sessão). */
  async requestPairingCode(id: string, phone?: string): Promise<{ code: string }> {
    // O pairing code é gerado para um número: sem número na sessão nem na requisição, use o QR.
    if (!phone && !(await this.store.get(id)).phone) {
      throw new SessionError('VALIDATION_ERROR', 'informe o número para gerar o pairing code (ou conecte por QR Code)', 'phone')
    }
    const row = await this.prepareAuth(id)
    const pairingPhone = phone ?? row.phone!
    let rt = this.runtimes.get(id)
    if (rt && rt.pairingPhone === pairingPhone && rt.pairingCode) return { code: rt.pairingCode }
    if (rt && rt.pairingPhone !== pairingPhone) {
      await this.dispose(rt, 'local')
      rt = undefined
    }
    if (!rt) rt = await this.openRuntime(id, { pairingPhone, deferConnect: true })
    const code = this.waitPairingCode(rt)
    if (!rt.started) void this.startConnect(rt).catch(() => {})
    return { code: await code }
  }

  // ---- ações manuais (AC-T05-06) -------------------------------------------------

  async pause(id: string): Promise<SessionView> {
    const row = await this.store.get(id)
    assertAction('pause', row.status)
    return this.applyTransition(id, 'PAUSED')
  }

  /** Resume é sempre manual: PAUSED → WARMING|STABLE. Reabre a conexão se não houver uma. */
  async resume(id: string): Promise<SessionView> {
    const row = await this.store.get(id)
    assertAction('resume', row.status)
    const target = this.opts.resumeState ? await this.opts.resumeState(row) : 'WARMING'
    const view = await this.applyTransition(id, target)
    if (!this.runtimes.has(id)) await this.openRuntime(id)
    return view
  }

  /** Fecha e reabre a conexão sem mudar o estado; aplica a troca de proxy (limpa requires_restart). */
  async restart(id: string): Promise<SessionView> {
    const row = await this.store.get(id)
    assertAction('restart', row.status)
    const rt = this.runtimes.get(id)
    if (rt) await this.dispose(rt, 'local')
    await this.openRuntime(id)
    return this.get(id)
  }

  /** Desloga o dispositivo, apaga as credenciais e vai para DISCONNECTED. */
  async logout(id: string): Promise<SessionView> {
    const row = await this.store.get(id)
    assertAction('logout', row.status)
    const rt = this.runtimes.get(id)
    if (rt) {
      rt.closing = true
      if (rt.connected) {
        try {
          await rt.transport.logout()
        } catch (err) {
          this.log.warn({ session_id: id, err }, 'transport logout failed')
        }
      }
      await this.dispose(rt, 'local')
    }
    const auth = rt?.auth ?? (await this.authState(id))
    await auth.clear()
    await this.store.recordHealthEvent(id, 'logged_out', { manual: true })
    return this.applyTransition(id, 'DISCONNECTED')
  }

  /**
   * Exclui a sessão: desvincula o aparelho (se conectado), fecha a conexão e apaga a sessão do banco
   * (credenciais e histórico caem em cascata). Válido em qualquer estado.
   */
  async remove(id: string): Promise<{ deletedProxyId: string | null }> {
    await this.store.get(id)
    const rt = this.runtimes.get(id)
    if (rt) {
      rt.closing = true
      if (rt.connected) {
        try {
          await rt.transport.logout()
        } catch (err) {
          this.log.warn({ session_id: id, err }, 'transport logout failed')
        }
      }
      await this.dispose(rt, 'local')
    }
    const result = await this.store.delete(id)
    this.log.info({ session_id: id }, 'session removed')
    return result
  }

  // ---- internos ---------------------------------------------------------------------

  private async prepareAuth(id: string): Promise<SessionRow> {
    const row = await this.store.get(id)
    assertAction('connect', row.status)
    if (row.status !== 'DISCONNECTED') return row
    const res = await this.store.transition(id, 'NEW')
    this.emit('state', { sessionId: id, from: res.from, to: res.to })
    return res.row
  }

  private async applyTransition(id: string, to: SessionState, set?: TransitionOptions['set']): Promise<SessionView> {
    const res = await this.store.transition(id, to, set ? { set } : {})
    if (res.changed) {
      this.log.info({ session_id: id, from: res.from, to: res.to }, 'session state changed')
      this.emit('state', { sessionId: id, from: res.from, to: res.to })
    }
    return toSessionView(res.row)
  }

  /** Força DISCONNECTED (* → DISCONNECTED é sempre permitido). */
  private async markDisconnected(id: string): Promise<void> {
    await this.applyTransitionSafe(id, 'DISCONNECTED')
  }

  private async applyTransitionSafe(id: string, to: SessionState): Promise<void> {
    const row = await this.store.find(id)
    if (!row || row.status === to) return
    if (!canTransition(row.status, to)) {
      this.log.warn({ session_id: id, from: row.status, to }, 'skipping invalid transition')
      return
    }
    await this.applyTransition(id, to)
  }

  private authState(id: string): Promise<PostgresAuthState> {
    return (this.opts.authStateFactory ?? usePostgresAuthState)(this.opts.db, id)
  }

  private async openRuntime(id: string, o: { pairingPhone?: string; deferConnect?: boolean } = {}): Promise<Runtime> {
    const auth = await this.authState(id)
    const transport = this.opts.transportFactory(id)
    const rt: Runtime = {
      sessionId: id,
      transport,
      auth,
      connected: false,
      monitoring: false,
      failures: 0,
      closing: false,
      disposed: false,
      pairingWaiters: [],
      chain: Promise.resolve(),
      started: false,
      attempt: 0,
    }
    if (o.pairingPhone) rt.pairingPhone = o.pairingPhone
    this.runtimes.set(id, rt)
    this.wire(rt)
    if (!o.deferConnect) await this.startConnect(rt)
    return rt
  }

  private startConnect(rt: Runtime): Promise<void> {
    rt.started = true
    return this.enqueue(rt, () => this.connect(rt))
  }

  private isCurrent(rt: Runtime): boolean {
    return !rt.disposed && this.runtimes.get(rt.sessionId) === rt
  }

  private wire(rt: Runtime): void {
    const { transport, sessionId } = rt
    transport.on('qr', (raw) => {
      if (!this.isCurrent(rt)) return
      const dataUrl = toQrDataUrl(raw)
      dataUrl.catch((err) => this.log.error({ session_id: sessionId, err }, 'qr render failed'))
      this.track(dataUrl)
      rt.qr = { raw, at: this.now(), dataUrl }
      this.emit('qr', { sessionId, qr: raw })
    })
    transport.on('pairing-code', (code) => {
      if (!this.isCurrent(rt)) return
      rt.pairingCode = code
      for (const w of rt.pairingWaiters.splice(0)) w.resolve(code)
      this.emit('pairing-code', { sessionId, code })
    })
    transport.on('connection', (u) => {
      if (!this.isCurrent(rt) || rt.closing) return
      if (u.state === 'open') void this.enqueue(rt, () => this.onOpen(rt)).catch(() => {})
      else void this.enqueue(rt, () => this.onClose(rt, u.reason ?? 'transient', u.statusCode)).catch(() => {})
    })
  }

  /** Serializa o tratamento de eventos da sessão (ordem open/close preservada). */
  private enqueue<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
    const run = rt.chain.then(() => (this.isCurrent(rt) ? fn() : (undefined as T)))
    rt.chain = run.catch((err) => this.log.error({ session_id: rt.sessionId, err }, 'session task failed'))
    this.track(rt.chain)
    return run
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.then(
      () => undefined,
      () => undefined,
    )
    this.pending.add(tracked)
    void tracked.finally(() => this.pending.delete(tracked))
  }

  private async connect(rt: Runtime): Promise<void> {
    const { sessionId, transport, auth } = rt
    const before = await this.store.find(sessionId)
    try {
      await connectSession({
        db: this.opts.db,
        transport,
        sessionId,
        auth: auth.state,
        saveCreds: auth.saveCreds,
        ...(rt.pairingPhone ? { pairingPhone: rt.pairingPhone } : {}),
      })
    } catch (err) {
      if (err instanceof ProxyError && err.code === 'PROXY_UNAVAILABLE') {
        // connectSession já marcou DISCONNECTED e NÃO chamou transport.connect (sem fallback, AC-T06-05).
        this.log.warn({ session_id: sessionId, err: err.message }, 'proxy unavailable: session disconnected')
        await this.store.recordHealthEvent(sessionId, 'proxy_unavailable', { message: err.message })
        if (before && before.status !== 'DISCONNECTED') this.emit('state', { sessionId, from: before.status, to: 'DISCONNECTED' })
        await this.dispose(rt, 'local')
        return
      }
      if (err instanceof ProxyError && err.code === 'SESSION_NOT_FOUND') {
        await this.dispose(rt, 'local')
        throw err
      }
      this.log.warn({ session_id: sessionId, err }, 'transport connect failed')
      await this.onClose(rt, 'transient', undefined, err)
      return
    }
    // A conexão usou o proxy atual do banco: a troca pendente foi aplicada (AC-T06-03).
    if (before?.requiresRestart && this.isCurrent(rt)) await this.store.update(sessionId, { requiresRestart: false })
    if (auth.state.creds.registered) this.watchConnect(rt)
  }

  /**
   * Conta pareada cuja conexão não abre nem falha (ex.: túnel do proxy pendurado) ficaria offline sem aviso:
   * passado o prazo, a tentativa vira queda transitória e segue o backoff normal. QR/pairing não são vigiados.
   */
  private watchConnect(rt: Runtime): void {
    const attempt = ++rt.attempt
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.stopped || !this.isCurrent(rt) || rt.connected || rt.closing || rt.attempt !== attempt) return
      this.log.warn({ session_id: rt.sessionId, timeout_ms: this.connectTimeoutMs }, 'connection did not open in time')
      void this.enqueue(rt, async () => {
        if (!this.isCurrent(rt) || rt.connected || rt.attempt !== attempt) return
        await this.onClose(rt, 'transient', undefined, new Error(`connection did not open within ${this.connectTimeoutMs}ms`))
      }).catch(() => undefined)
    }, this.connectTimeoutMs)
    timer.unref?.()
    this.timers.set(timer, () => undefined)
  }

  /**
   * Sessão que caiu só porque o proxy ficou indisponível (último evento `proxy_unavailable`, credenciais intactas):
   * com o proxy de volta, reconecta pelo mesmo caminho da reconexão manual, sem QR e mantendo o aquecimento.
   */
  async recoverAfterProxy(id: string): Promise<boolean> {
    if (this.stopped || this.runtimes.has(id)) return false
    const row = await this.store.find(id)
    if (!row || row.status !== 'DISCONNECTED' || !row.proxyId) return false
    if ((await this.store.lastHealthEventType(id)) !== 'proxy_unavailable') return false
    if (!(await this.store.hasCredentials(id))) return false
    this.log.info({ session_id: id }, 'proxy available again: reconnecting session')
    await this.startQr(id)
    return true
  }

  private async onOpen(rt: Runtime): Promise<void> {
    const { sessionId } = rt
    rt.connected = true
    rt.failures = 0
    rt.qr = undefined
    // Persiste as credenciais (cifradas, T02) assim que a conexão abre.
    await rt.auth.saveCreds()
    const now = this.now()
    const row = await this.store.get(sessionId)
    let state = row.status
    if (row.status === 'NEW') {
      const view = await this.applyTransition(sessionId, 'WARMING', { warmupStartedAt: row.warmupStartedAt ?? now, lastConnectedAt: now })
      state = view.status
    } else {
      await this.store.update(sessionId, { lastConnectedAt: now })
    }
    await this.store.recordHealthEvent(sessionId, 'connected', { state })
    // Cadastro por QR sem número (ou número digitado errado): vale o número da conta que de fato conectou.
    const ownPhone = rt.transport.ownPhone?.()
    if (ownPhone && ownPhone !== row.phone) {
      await this.store.update(sessionId, { phone: ownPhone })
      if (row.phone) this.log.warn({ session_id: sessionId }, 'session phone replaced by the connected account number')
    }
    this.log.info({ session_id: sessionId, state }, 'session connected')
    const ctx: ConnectedContext = { sessionId, transport: rt.transport, state }
    rt.monitoring = true
    this.emit('connected', ctx)
    if (this.opts.onConnected) {
      try {
        await this.opts.onConnected(sessionId, ctx)
      } catch (err) {
        this.log.error({ session_id: sessionId, err }, 'onConnected hook failed')
      }
    }
  }

  private async onClose(rt: Runtime, reason: 'loggedOut' | 'forbidden' | 'transient', statusCode?: number, error?: unknown): Promise<void> {
    const { sessionId } = rt
    const wasConnected = rt.connected
    rt.connected = false
    rt.attempt++ // a queda já foi tratada: o vigia da tentativa anterior não age mais
    await this.stopMonitoring(rt, reason, statusCode)
    const detail: Record<string, unknown> = { reason }
    if (statusCode !== undefined) detail.statusCode = statusCode
    if (error) detail.error = error instanceof Error ? error.message : String(error)

    if (reason === 'loggedOut') {
      await this.store.recordHealthEvent(sessionId, 'disconnected', detail)
      await this.dispose(rt, 'local')
      // Credenciais deslogadas não servem mais: nova autenticação exige QR/pairing.
      await rt.auth.clear()
      await this.markDisconnected(sessionId)
      return
    }

    if (reason === 'forbidden') {
      await this.store.recordHealthEvent(sessionId, 'forbidden_403', statusCode === undefined ? {} : { statusCode })
      await this.dispose(rt, 'local')
      const row = await this.store.find(sessionId)
      if (row && row.status !== 'PAUSED') await this.applyTransitionSafe(sessionId, canTransition(row.status, 'PAUSED') ? 'PAUSED' : 'DISCONNECTED')
      return
    }

    await this.store.recordHealthEvent(sessionId, 'disconnected', { ...detail, wasConnected })
    rt.failures += 1
    if (rt.failures > this.maxAttempts) {
      this.log.warn({ session_id: sessionId, attempts: rt.failures - 1 }, 'reconnect attempts exhausted')
      await this.store.recordHealthEvent(sessionId, 'reconnect_failed', { attempts: rt.failures - 1 })
      await this.dispose(rt, 'local')
      await this.markDisconnected(sessionId)
      return
    }
    const attempt = rt.failures
    const delayMs = this.backoff(attempt)
    this.log.info({ session_id: sessionId, attempt, delay_ms: delayMs }, 'scheduling reconnect')
    this.emit('reconnect', { sessionId, attempt, delayMs })
    // A espera fica fora da fila da sessão; ao acordar, a reconexão só roda se o runtime ainda for o atual.
    this.track(
      this.sleep(delayMs).then(() => {
        if (this.isCurrent(rt) && !this.stopped) return this.enqueue(rt, () => this.connect(rt))
      }),
    )
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve()
      }, ms)
      this.timers.set(timer, resolve)
    })
  }

  private waitPairingCode(rt: Runtime): Promise<string> {
    const timeoutMs = this.opts.pairingTimeoutMs ?? 30_000
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        rt.pairingWaiters = rt.pairingWaiters.filter((w) => w !== waiter)
        reject(new SessionManagerError('PAIRING_TIMEOUT', `pairing code not received within ${timeoutMs}ms`))
      }, timeoutMs)
      const waiter: Waiter = {
        resolve: (code) => {
          clearTimeout(timer)
          resolve(code)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }
      rt.pairingWaiters.push(waiter)
    })
  }

  private async stopMonitoring(rt: Runtime, reason: DisconnectedContext['reason'], statusCode?: number): Promise<void> {
    if (!rt.monitoring) return
    rt.monitoring = false
    const ctx: DisconnectedContext = statusCode === undefined ? { sessionId: rt.sessionId, reason } : { sessionId: rt.sessionId, reason, statusCode }
    this.emit('disconnected', ctx)
    if (this.opts.onDisconnected) {
      try {
        await this.opts.onDisconnected(rt.sessionId, ctx)
      } catch (err) {
        this.log.error({ session_id: rt.sessionId, err }, 'onDisconnected hook failed')
      }
    }
  }

  private async dispose(rt: Runtime, reason: DisconnectedContext['reason']): Promise<void> {
    if (rt.disposed) return
    rt.closing = true
    await this.stopMonitoring(rt, reason)
    rt.disposed = true
    rt.connected = false
    if (this.runtimes.get(rt.sessionId) === rt) this.runtimes.delete(rt.sessionId)
    for (const w of rt.pairingWaiters.splice(0)) w.reject(new SessionManagerError('CONNECTION_CLOSED', 'connection closed before pairing code'))
    try {
      await rt.transport.close()
    } catch (err) {
      this.log.warn({ session_id: rt.sessionId, err }, 'transport close failed')
    }
  }
}

function safeChild(l: typeof coreLogger | undefined): SessionManagerLogger | undefined {
  try {
    return l?.child({ component: 'session-manager' })
  } catch {
    return undefined
  }
}
