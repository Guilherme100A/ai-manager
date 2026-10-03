// Limite de chips por IP: quantas sessões podem usar o mesmo IP/host e porta de proxy (ligável no painel).
import { and, eq, ne, sql } from 'drizzle-orm'
import { proxies, proxySettings, sessions, type Database } from '@wsm/db'

export interface ProxySharingSettings { enabled: boolean; maxSessionsPerIp: number }
export const DEFAULT_PROXY_SHARING: ProxySharingSettings = { enabled: false, maxSessionsPerIp: 3 }
export const MAX_SESSIONS_PER_IP_LIMIT = 50

type Executor = Pick<Database, 'select' | 'execute'>

export async function getProxySharing(db: Pick<Database, 'select'>): Promise<ProxySharingSettings> {
  const [row] = await db.select().from(proxySettings).where(eq(proxySettings.id, 1))
  return row ? { enabled: row.ipLimitEnabled, maxSessionsPerIp: row.maxSessionsPerIp } : { ...DEFAULT_PROXY_SHARING }
}

export async function saveProxySharing(db: Database, input: ProxySharingSettings): Promise<ProxySharingSettings> {
  const max = Math.trunc(input.maxSessionsPerIp)
  if (!Number.isFinite(max) || max < 1 || max > MAX_SESSIONS_PER_IP_LIMIT) throw new Error(`maxSessionsPerIp must be between 1 and ${MAX_SESSIONS_PER_IP_LIMIT}`)
  const values = { id: 1, ipLimitEnabled: input.enabled, maxSessionsPerIp: max, updatedAt: new Date() }
  await db.insert(proxySettings).values(values).onConflictDoUpdate({ target: proxySettings.id, set: values })
  return { enabled: input.enabled, maxSessionsPerIp: max }
}

/** Quantas sessões (fora `exceptSessionId`) usam um proxy com este host e porta. Host comparado sem maiúsculas. */
export async function sessionsOnIp(db: Pick<Database, 'select'>, host: string, port: number, exceptSessionId?: string): Promise<number> {
  const sameIp = and(sql`lower(${proxies.host}) = ${host.trim().toLowerCase()}`, eq(proxies.port, port))
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .innerJoin(proxies, eq(sessions.proxyId, proxies.id))
    .where(exceptSessionId ? and(sameIp, ne(sessions.id, exceptSessionId)) : sameIp)
  return Number(row?.n ?? 0)
}

/**
 * Com o limite ligado, recusa usar este IP se ele já está no máximo de sessões. Roda dentro da transação que grava a
 * sessão, com um lock por IP: dois cadastros simultâneos no mesmo IP não passam do limite.
 * Devolve a mensagem de recusa ou undefined (permitido).
 */
export async function checkProxySharing(tx: Executor, host: string, port: number, exceptSessionId?: string): Promise<string | undefined> {
  const settings = await getProxySharing(tx)
  if (!settings.enabled) return undefined
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`proxy-ip:${host.trim().toLowerCase()}:${port}`}))`)
  const used = await sessionsOnIp(tx, host, port, exceptSessionId)
  if (used < settings.maxSessionsPerIp) return undefined
  return `O IP ${host}:${port} já está em ${used} chip(s); o limite é ${settings.maxSessionsPerIp} por IP. Use outro IP ou desligue o limite em Sessões.`
}
