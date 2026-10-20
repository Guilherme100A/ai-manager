// Entrypoint HTTP: lê env, cria dependências reais e sobe o servidor.
// T16: logger de observabilidade (T15), métricas do processo e ponte com o worker (WORKER_INTERNAL_URL).
import { serve } from '@hono/node-server'
import { createMetrics, sessionProxyFetch, SpyFinder, SpyHttp, SpyRunner, SpyStore } from '@wsm/core'
import { createDb } from '@wsm/db'
import { Redis } from 'ioredis'
import { createApp } from './app'
import { createWorkerBridge } from './bridge/client'
import { loadConfig } from './config'
import { createApiLogger } from './observability'

const config = loadConfig()
const logger = createApiLogger({ level: config.LOG_LEVEL })
const db = createDb(config.DATABASE_URL)
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 })
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'))
const metrics = createMetrics()

const bridge =
  config.WORKER_INTERNAL_URL && config.INTERNAL_TOKEN ? createWorkerBridge({ url: config.WORKER_INTERNAL_URL, token: config.INTERNAL_TOKEN }) : undefined
if (!bridge) logger.warn('WORKER_INTERNAL_URL not set: session/queue actions unavailable (database-only mode)')

// T13 (IA assistiva): quando aceito, as rotas /api/suggestions entram pelo registro em routes/index.ts;
// se precisarem do worker, adicionar o alvo correspondente na ponte (bridge/client.ts + boot/internal-server.ts).
const app = createApp({
  db,
  redis,
  logger,
  apiToken: config.API_TOKEN,
  metrics,
  ...(bridge ? { sessions: bridge.sessions, messages: bridge.messages, health: bridge.health } : {}),
})
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  logger.info({ port: info.port, worker_bridge: Boolean(bridge) }, 'api listening')
})

// Espião de funil: um link por vez, devagar (Facebook e buscador sem login).
const spy = config.SPY_RUNNER === 'on'
  ? new SpyRunner({ store: new SpyStore(db), finder: new SpyFinder(new SpyHttp({
    serperKey: config.SPY_SERPER_KEY,
    ...(config.SPY_PROXY_SESSION ? { facebookFetch: sessionProxyFetch(db, config.SPY_PROXY_SESSION) } : {}),
  })), logger })
  : undefined
spy?.start()

let closing = false
async function shutdown(signal: string) {
  if (closing) return
  closing = true
  logger.info({ signal }, 'shutting down')
  server.close()
  await Promise.allSettled([db.$client.end(), redis.quit()])
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
