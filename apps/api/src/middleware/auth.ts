// Auth Bearer para `/api/*` (AC-T03-02, AC-T17-02). Aceita o token de login do painel (T17) ou o API_TOKEN
// (integrações). Comparação em tempo constante. `POST /api/auth/login` é público.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { authServiceFor, isLoginToken } from '../auth'
import { rememberedLoginActive } from '../auth/remembered'
import { ApiError } from '../errors'
import type { AppDeps, AppEnv } from '../types'

const digest = (s: string) => createHash('sha256').update(s).digest()

export function tokenMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected))
}

/** Extrai o token de `Authorization: Bearer <token>`; `undefined` se ausente/malformado. */
export function parseBearer(header: string | undefined): string | undefined {
  const m = header?.match(/^Bearer\s+(\S+)\s*$/i)
  return m?.[1]
}

/** Rotas de `/api/*` que não exigem token. */
export const PUBLIC_API_ROUTES: ReadonlyArray<{ method: string; path: string }> = [{ method: 'POST', path: '/api/auth/login' }]

export function isPublicApiRoute(method: string, path: string): boolean {
  const p = path.replace(/\/+$/, '')
  return PUBLIC_API_ROUTES.some((r) => r.method === method && r.path === p)
}

/**
 * Token de login do painel (T17). Registrado antes do `bearerAuth`: com um token de login válido, define o actor
 * (usuário) e o `bearerAuth` deixa passar. Token de login inválido, expirado ou revogado → 401.
 */
export function loginTokenAuth(deps: Pick<AppDeps, 'auth' | 'logger' | 'db'>): MiddlewareHandler<AppEnv> {
  const auth = authServiceFor(deps)
  return async (c, next) => {
    if (isPublicApiRoute(c.req.method, c.req.path)) {
      c.set('actor', 'anonymous')
      return next()
    }
    const token = parseBearer(c.req.header('authorization'))
    if (token && isLoginToken(token)) {
      const claims = auth.verify(token)
      if (!claims) throw new ApiError('UNAUTHORIZED', 'invalid or expired session token')
      if (claims.remember && !(await rememberedLoginActive(deps.db, token, claims))) throw new ApiError('UNAUTHORIZED', 'invalid or revoked remembered session')
      c.set('actor', claims.sub)
    }
    await next()
  }
}

export function bearerAuth(apiToken: string): MiddlewareHandler<AppEnv> {
  if (!apiToken) throw new Error('apiToken is required')
  return async (c, next) => {
    // Já autenticado pelo token de login (ou rota pública), no loginTokenAuth.
    if (c.get('actor')) return next()
    const token = parseBearer(c.req.header('authorization'))
    if (!token || !tokenMatches(token, apiToken)) {
      throw new ApiError('UNAUTHORIZED', 'missing or invalid bearer token')
    }
    c.set('actor', 'api_token')
    await next()
  }
}
