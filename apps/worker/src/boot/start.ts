// Boot do worker (T16): monta todas as peças aceitas nas tarefas anteriores num processo só.
// Ordem: config → crypto → db/migrations → Redis → transporte → HealthMonitor → SessionManager → fila (deliver
// com antiban + marca de envio) → reconciliação de `processing` → opt-out, proxies, alertas, métricas →
// servidores (observabilidade e interno) → reconexão das sessões. Shutdown fecha tudo na ordem inversa.
import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import {
  AiAssistant,
  AiSettingsService,
  SmallGroupModel,
  AlertDispatcher,
  attachMetrics,
  bindTransportSession,
  createMetrics,
  createAiProvider,
  createAntibanAdapter,
  initCredentialsCrypto,
  MessageQueue,
  MessageStore,
  SessionLimitsService,
  SessionLinkStore,
  SessionRouter,
  SendPipeline,
  toConnectionOptions,
  type Logger,
} from '@wsm/core'
import { createDb, runMigrations, sessions, type Database } from '@wsm/db'
import { attachAlerts } from '../alerts'
import { HealthMonitor } from '../health'
import { createWorkerLogger, startObservabilityServer, type ObservabilityServer } from '../observability'
import { attachAi } from '../ai'
import { startProxyMonitor, type ProxyMonitor } from '../proxy'
import { attachQueueToSessions } from '../queue'
import { createTransportFactory, SessionManager, type TransportFactory } from '../sessions'
import { loadWorkerConfig, type WorkerConfig } from './config'
import { FakeControl } from './fake-control'
import { startInternalServer, type InternalServer } from './internal-server'
import { createBridgeTargets } from './bridge-targets'
import { GroupAutomation } from '../groups/automation'
import { RedisGroupAutomationStore } from '../groups/store'
import { recoverOrphanJobs, type RecoverOrphanJobsResult } from './orphan-jobs'
import { reconcileProcessing, type ReconcileResult } from './reconcile'
import { createGuardedDeliver, redisInflightStore, type InflightStore } from './send-guard'

export interface StartWorkerOptions {
  env?: Record<string, string | undefined>
  config?: Partial<WorkerConfig>
  logger?: Logger
  /** Substitui a factory de transporte (testes). */
  transportFactory?: TransportFactory
  /** Intervalo do Health Monitor (default do T10). */
  healthIntervalMs?: number
  /** Intervalo do verificador de proxies (default do T06). */
  proxyCheckIntervalMs?: number
}

export interface WorkerHandle {
  config: WorkerConfig
  db: Database
  manager: SessionManager
  queue: MessageQueue
  health: HealthMonitor
  fake?: FakeControl
  bootId: string
  reconciled: ReconcileResult
  orphans: RecoverOrphanJobsResult
  observability: ObservabilityServer
  internal: InternalServer
  stop(): Promise<void>
}

export async function startWorker(opts: StartWorkerOptions = {}): Promise<WorkerHandle> {
  const env = opts.env ?? process.env
  const config: WorkerConfig = { ...loadWorkerConfig(env), ...opts.config }
  const logger = opts.logger ?? createWorkerLogger({ level: config.logLevel })
  const bootId = randomUUID()
  const cleanups: Array<{ name: string; fn: () => unknown | Promise<unknown> }> = []
  const onStop = (name: string, fn: () => unknown | Promise<unknown>) => cleanups.unshift({ name, fn })

  const stopAll = async () => {
    for (const { name, fn } of cleanups.splice(0)) {
      try {
        await fn()
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), step: name }, 'shutdown step failed')
      }
    }
  }

  try {
    initCredentialsCrypto(env.CREDENTIALS_KEY)

    const db = createDb(config.databaseUrl)
    onStop('db', () => db.$client.end())
    await runMigrations(db)

    const connection = toConnectionOptions({ url: config.redisUrl })
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 })
    redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'))
    onStop('redis', () => redis.quit())
    const inflight: InflightStore = redisInflightStore(redis, config.queuePrefix)

    // ---- transporte ------------------------------------------------------------------------
    const fake = config.transport === 'fake' ? new FakeControl({ redis, prefix: config.queuePrefix, bootId, logger }) : undefined
    const baseFactory = opts.transportFactory ?? fake?.factory ?? createTransportFactory({ kind: config.transport })
    const transportFactory: TransportFactory = (sessionId) => {
      const t = baseFactory(sessionId)
      bindTransportSession(t, sessionId)
      return t
    }
    if (fake) logger.warn({ wa_transport: 'fake' }, 'WA_TRANSPORT=fake: FakeTransport em uso (somente testes)')

    // ---- fila + saúde + sessões -----------------------------------------------------------------
    const limits = new SessionLimitsService(db)
    const antiban = createAntibanAdapter({ env, mode: config.antibanMode, logger })
    logger.info({ antiban_mode: antiban.mode }, 'antiban adapter ready')
    // O HealthMonitor é criado depois da fila (usa a fila para pausar); o deliver o alcança por referência.
    const healthRef: { current?: HealthMonitor } = {}
    const queue = new MessageQueue({
      db,
      connection: { url: config.redisUrl },
      prefix: config.queuePrefix,
      logger,
      deliver: createGuardedDeliver({
        antiban,
        inflight,
        health: { recordSignal: (id, type, detail) => healthRef.current?.recordSignal(id, type, detail) },
        limits,
        logger,
        ...(fake ? { delays: fake } : {}),
      }),
    })

    const monitor = new HealthMonitor({
      db,
      logger,
      queueControl: queue,
      ...(opts.healthIntervalMs !== undefined ? { intervalMs: opts.healthIntervalMs } : {}),
    })
    healthRef.current = monitor
    onStop('health', () => monitor.stop())
    const manager = new SessionManager({
      db,
      logger,
      transportFactory,
      onConnected: monitor.onConnected,
      onDisconnected: monitor.onDisconnected,
      resumeState: monitor.resumeState,
    })
    monitor.attach(manager)
    onStop('sessions', () => manager.stop())
    // Registrado depois das sessões → roda ANTES delas no shutdown: a fila espera o envio em curso terminar
    // (BullMQ Worker.close) enquanto o transporte ainda está aberto.
    onStop('queue', () => queue.close())
    onStop('queue-attach', attachQueueToSessions(manager, queue, { logger }))

    // ---- reconciliação de mensagens presas em processing (AC-T16-05) -------------------------
    const requeueQueues = new Map<string, Queue>()
    onStop('requeue-queues', () => Promise.allSettled([...requeueQueues.values()].map((q) => q.close())))
    const queueFor = (sessionId: string): Queue => {
      let q = requeueQueues.get(sessionId)
      if (!q) {
        q = new Queue(sessionId, { connection, prefix: `${config.queuePrefix}:session` })
        requeueQueues.set(sessionId, q)
      }
      return q
    }
    const JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: 1000 }
    const reconciled = await reconcileProcessing({
      db,
      inflight,
      logger,
      requeue: async (sessionId, messageId) => {
        const q = queueFor(sessionId)
        const existing = await q.getJob(messageId)
        const state = existing ? await existing.getState() : undefined
        // Job ainda vivo (espera, atrasado ou ativo órfão, que recoverOrphanJobs devolve à espera): nada a fazer.
        if (existing && state !== 'completed' && state !== 'failed' && state !== 'unknown') return
        if (existing) await existing.remove().catch(() => undefined)
        await q.add('send', { messageId }, { ...JOB_OPTIONS, jobId: messageId })
      },
    })
    const store = new MessageStore(db)
    const orphans = await recoverOrphanJobs({
      sessionIds: (await db.select({ id: sessions.id }).from(sessions)).map((r) => r.id),
      queueFor,
      redis,
      messageStatus: async (id) => (await store.find(id))?.status,
      jobOptions: JOB_OPTIONS,
      logger,
    })

    // ---- inbound + opt-out (T07) + IA assistiva (T13) ------------------------------------------
    // attachAi assina `message` de cada transporte conectado: persiste o inbound, aplica o opt-out ANTES de tudo
    // e só então aplica vínculos habilitados ou gera sugestões (pending_approval para respostas de IA).
    const routingPipeline = new SendPipeline({ db, queue, limits, getTransport: (id) => manager.getTransport(id) })
    const sessionRouter = new SessionRouter(new SessionLinkStore(db).dependencies((request) => routingPipeline.send(request)))
    const ai = attachAi(manager, {
      db,
      logger,
      routeIncoming: (event) => sessionRouter.route(event),
      // T19 — configuração dinâmica: tabela ai_settings (painel) com fallback no ambiente AI_*, relida a cada
      // AI_SETTINGS_REFRESH_MS (default 5 s) sem restart. Sem chave ou enabled=false → só o fallback determinístico.
      assistant: new AiAssistant({
        settings: new AiSettingsService({ db, env }),
        providerFactory: createAiProvider,
        refreshMs: aiRefreshMs(env),
        logger,
      }),
    })
    onStop('ai', async () => {
      ai.stop()
      await ai.idle()
    })

    const bridgeTargets = createBridgeTargets({ manager, queue, health: monitor, db })
    const groupSettings = new AiSettingsService({ db, env })
    const groupAutomation = new GroupAutomation({
      manager, store: new RedisGroupAutomationStore(redis, config.queuePrefix), limits,
      pipeline: routingPipeline, messages: queue, model: new SmallGroupModel(() => groupSettings.resolve()),
      invites: bridgeTargets.groupInvites, logger,
      audit: async (sessionId, detail) => {
        const { auditLogs } = await import('@wsm/db')
        await db.insert(auditLogs).values({ actor: 'group-automation', action: 'group.automation', targetType: 'session', targetId: sessionId, detail })
      },
    })
    bridgeTargets.sessions.getGroupAutomation = (id) => groupAutomation.view(id)
    bridgeTargets.sessions.configureGroupAutomation = (id, input) => groupAutomation.configure(id, input)
    bridgeTargets.sessions.tickGroupAutomation = async (id) => {
      await manager.get(id)
      return groupAutomation.requestTick(id)
    }
    onStop('group-automation', () => groupAutomation.stop())

    // ---- proxies (T06) + alertas (T11) + métricas (T15) --------------------------------------
    const proxyMonitor: ProxyMonitor = startProxyMonitor({ db, logger, ...(opts.proxyCheckIntervalMs ? { intervalMs: opts.proxyCheckIntervalMs } : {}) })
    onStop('proxy-monitor', () => proxyMonitor.stop())
    const alerts = attachAlerts({ dispatcher: new AlertDispatcher({ db, logger }), healthMonitor: monitor, proxyChecker: proxyMonitor.checker, logger })
    onStop('alerts', async () => {
      alerts.stop()
      await alerts.idle()
    })
    const metrics = createMetrics()
    onStop('metrics', attachMetrics({ metrics, queue, manager, db }))


    // ---- servidores ----------------------------------------------------------------------------
    const observability = await startObservabilityServer({
      port: config.healthPort,
      metrics,
      check: async () => {
        await db.$client.query('select 1')
        return (await redis.ping()) === 'PONG'
      },
    })
    onStop('observability', () => observability.close())
    const internal = await startInternalServer({
      port: config.internalPort,
      host: config.internalHost,
      token: config.internalToken,
      targets: bridgeTargets,
      ...(fake ? { fake } : {}),
      logger,
    })
    onStop('internal', () => internal.close())

    // ---- reconexão das sessões (AC-T05-04) e retomada das filas -----------------------------
    await manager.start()
    await resumeQueues(db, queue, logger)
    await groupAutomation.start()

    logger.info(
      { boot_id: bootId, wa_transport: config.transport, health_port: observability.port, internal_port: internal.port, reconciled: counts(reconciled) },
      'worker started',
    )

    let stopped: Promise<void> | undefined
    return {
      config,
      db,
      manager,
      queue,
      health: monitor,
      ...(fake ? { fake } : {}),
      bootId,
      reconciled,
      orphans,
      observability,
      internal,
      stop: () => (stopped ??= stopAll()),
    }
  } catch (err) {
    await stopAll()
    throw err
  }
}

/** Liga o Worker da fila de toda sessão com mensagens pendentes (a entrega espera a sessão poder enviar). */
async function resumeQueues(db: Database, queue: MessageQueue, logger: Logger): Promise<void> {
  const { rows } = await db.$client.query<{ session_id: string }>(
    "select distinct session_id from messages where status in ('queued', 'retrying') and direction = 'outbound'",
  )
  for (const { session_id } of rows) {
    await queue.startSession(session_id).catch((err: unknown) => logger.error({ session_id, err: String(err) }, 'queue worker start failed'))
  }
}

const counts = (r: ReconcileResult) => ({ sent: r.sent.length, retrying: r.retrying.length, failed: r.failed.length })

/** AI_SETTINGS_REFRESH_MS: validade da configuração de IA lida do banco (default 5000; mínimo 0). */
export function aiRefreshMs(env: Record<string, string | undefined>): number {
  const n = Number(env.AI_SETTINGS_REFRESH_MS)
  return env.AI_SETTINGS_REFRESH_MS?.trim() && Number.isFinite(n) && n >= 0 ? n : 5000
}
