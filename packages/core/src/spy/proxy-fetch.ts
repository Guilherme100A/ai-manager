// fetch por proxy para o Espião, com os mesmos agentes dos chips (http/https CONNECT ou socks5).
// A Facebook manda IP de datacenter para o login ao abrir posts; por um proxy residencial o post abre.
import { request } from 'node:https'
import { eq, or } from 'drizzle-orm'
import { sessions, type Database } from '@wsm/db'
import { resolveSessionProxy } from '../proxy/connect'
import { createProxyAgent } from '../transport/baileys'
import type { FetchFn } from './http'

/** FetchFn que sai pelo proxy; não segue redirecionamento (o SpyHttp cuida disso). Só https. */
export function proxyFetch(proxyUrl: string): FetchFn {
  const agent = createProxyAgent(proxyUrl)
  return (input, init = {}) => new Promise<Response>((resolve, reject) => {
    const url = new URL(input)
    if (url.protocol !== 'https:') return reject(new TypeError(`proxyFetch só aceita https: ${url.protocol}`))
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const body = typeof init.body === 'string' ? init.body : undefined
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const req = request(url, { method: init.method ?? 'GET', headers, agent }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('error', (err) => reject(new TypeError(`proxy: ${err.message}`)))
      res.on('end', () => {
        const out = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue
          for (const value of Array.isArray(v) ? v : [v]) out.append(k, value)
        }
        const status = res.statusCode ?? 502
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: out }))
      })
    })
    // Falha de rede vira TypeError, como no fetch nativo (o SpyHttp tenta de novo uma vez).
    req.on('error', (err) => reject(new TypeError(`proxy: ${err.message}`)))
    init.signal?.addEventListener('abort', () => req.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted')))
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Usa o proxy configurado numa sessão (chip), pelo nome ou id. O proxy é relido a cada `ttlMs`:
 * troca de proxy no chip vale para o Espião sem reiniciar a API. Sem proxy na sessão → erro claro.
 */
export function sessionProxyFetch(db: Database, session: string, opts: { ttlMs?: number; now?: () => number } = {}): FetchFn {
  const ttlMs = opts.ttlMs ?? 5 * 60_000
  const now = opts.now ?? Date.now
  let cached: { url: string; fetch: FetchFn; at: number } | undefined
  const resolve = async () => {
    if (cached && now() - cached.at < ttlMs) return cached.fetch
    const isUuid = /^[0-9a-f-]{36}$/i.test(session)
    const [row] = await db.select({ id: sessions.id }).from(sessions)
      .where(isUuid ? or(eq(sessions.id, session), eq(sessions.name, session)) : eq(sessions.name, session)).limit(1)
    if (!row) throw new Error(`SPY_PROXY_SESSION: sessão "${session}" não existe`)
    const { proxyUrl } = await resolveSessionProxy(db, row.id)
    if (!proxyUrl) throw new Error(`SPY_PROXY_SESSION: a sessão "${session}" não tem proxy`)
    if (cached?.url !== proxyUrl) cached = { url: proxyUrl, fetch: proxyFetch(proxyUrl), at: now() }
    else cached.at = now()
    return cached.fetch
  }
  return async (input, init) => (await resolve())(input, init)
}
