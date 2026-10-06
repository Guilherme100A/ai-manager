// Regra de conexão com proxy (AC-T06-05): sessão com proxy configurado NUNCA conecta sem ele.
// Proxy indisponível → a conexão falha e a sessão fica DISCONNECTED (sem fallback para conexão direta).
import { and, eq, isNull } from 'drizzle-orm'
import { proxies, sessions, type Database } from '@wsm/db'
import { browserForSession, type AuthenticationState, type BrowserDescription, type ConnectOptions, type WaTransport } from '../transport'
import { ProxyError, ProxyUnavailableError } from './errors'
import { proxyConnectionUrl } from './service'

export interface SessionProxy {
  proxyId?: string
  /** URL em claro (com senha) para o transporte; `undefined` só quando a sessão não tem proxy. */
  proxyUrl?: string
}

/**
 * Resolve a rede de uma sessão. Sessão sem proxy → `{}` (conexão direta é a configuração dela).
 * Proxy configurado mas indisponível → `ProxyUnavailableError`. Sessão inexistente → `SESSION_NOT_FOUND`.
 */
export async function resolveSessionProxy(db: Database, sessionId: string): Promise<SessionProxy> {
  const [row] = await db
    .select({ sessionId: sessions.id, proxyId: sessions.proxyId, proxy: proxies })
    .from(sessions)
    .leftJoin(proxies, eq(proxies.id, sessions.proxyId))
    .where(eq(sessions.id, sessionId))
  if (!row) throw new ProxyError('SESSION_NOT_FOUND', `session ${sessionId} not found`)
  if (!row.proxyId) return {}
  // proxy_id setado sem linha correspondente não deve ocorrer (FK); por segurança, trata como indisponível.
  if (!row.proxy) throw new ProxyUnavailableError(row.proxyId, 'proxy not found')
  if (!row.proxy.available) throw new ProxyUnavailableError(row.proxyId, row.proxy.lastError)
  let proxyUrl: string
  try {
    proxyUrl = proxyConnectionUrl(row.proxy)
  } catch (err) {
    throw new ProxyUnavailableError(row.proxyId, `cannot decrypt proxy credentials (${(err as Error).name})`)
  }
  return { proxyId: row.proxyId, proxyUrl }
}

export interface ConnectSessionOptions extends Omit<ConnectOptions, 'proxyUrl' | 'auth'> {
  db: Database
  transport: WaTransport
  auth: AuthenticationState
}

/**
 * Conecta a sessão usando o proxy configurado. Se o proxy não puder ser usado, NÃO chama
 * `transport.connect`, marca a sessão como `DISCONNECTED` e rejeita com o erro original.
 * O proxy é lido do banco a cada conexão: uma troca (AC-T06-03) vale a partir do próximo connect.
 */
export async function connectSession(opts: ConnectSessionOptions): Promise<SessionProxy> {
  const { db, transport, ...connect } = opts
  let resolved: SessionProxy
  try {
    resolved = await resolveSessionProxy(db, connect.sessionId)
  } catch (err) {
    if (err instanceof ProxyError && err.code === 'SESSION_NOT_FOUND') throw err
    await db
      .update(sessions)
      .set({ status: 'DISCONNECTED', updatedAt: new Date() })
      .where(eq(sessions.id, connect.sessionId))
    throw err
  }
  const browser = await resolveSessionBrowser(db, connect.sessionId)
  const connectOpts: ConnectOptions = resolved.proxyUrl ? { ...connect, browser, proxyUrl: resolved.proxyUrl } : { ...connect, browser }
  await transport.connect(connectOpts)
  return resolved
}

/**
 * Aparelho fixo da sessão: o gravado no banco; na 1ª vez, grava o derivado do id (o mesmo que a sessão já usava),
 * para que reconexões e mudanças futuras nas listas de fingerprint nunca troquem o aparelho de um chip existente.
 */
export async function resolveSessionBrowser(db: Database, sessionId: string): Promise<BrowserDescription> {
  const [row] = await db.select({ browser: sessions.browser }).from(sessions).where(eq(sessions.id, sessionId))
  if (row?.browser) return row.browser
  const browser = browserForSession(sessionId)
  const [saved] = await db
    .update(sessions)
    .set({ browser })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.browser)))
    .returning({ browser: sessions.browser })
  if (saved?.browser) return saved.browser
  const [again] = await db.select({ browser: sessions.browser }).from(sessions).where(eq(sessions.id, sessionId))
  return again?.browser ?? browser
}
