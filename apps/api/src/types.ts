// Tipos compartilhados da API: dependências injetáveis e variáveis de contexto do Hono.
import type { Database } from '@wsm/db'
import type { Logger } from 'pino'

/** Cliente Redis mínimo usado pela API (compatível com ioredis). */
export interface RedisLike {
  ping(): Promise<unknown>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
}

export interface AppDeps {
  /** `createDb(url)` do @wsm/db (Drizzle node-postgres). */
  db: Database
  /** Cliente ioredis. */
  redis: RedisLike
  /** Logger pino (use `createLogger` de ./logger se não tiver um). */
  logger: Logger
  /** Token Bearer exigido nas rotas `/api/*`. */
  apiToken: string
  /** Timeout dos checks do `/health` em ms (default 1000). */
  healthTimeoutMs?: number
}

/** Metadados de auditoria que uma rota pode definir via `setAudit(c, …)`. */
export interface AuditInfo {
  action?: string
  targetType?: string
  targetId?: string
  detail?: Record<string, unknown>
}

export interface AppEnv {
  Variables: {
    requestId: string
    logger: Logger
    actor: string
    audit: AuditInfo | undefined
  }
}
