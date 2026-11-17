// /api/auth (T17): login do painel com usuário/senha, sessão atual e logout (AC-T17-01/02).
// O login é público; me/logout exigem token (de login ou API_TOKEN). Tentativas de login são auditadas, sem a senha.
import { Hono } from 'hono'
import { z } from 'zod'
import { authServiceFor, clientIp, isLoginToken } from '../auth'
import { rememberLogin, revokeRememberedLogin } from '../auth/remembered'
import { ApiError } from '../errors'
import { setAudit, writeAudit } from '../middleware/audit'
import { parseBearer } from '../middleware/auth'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

export const loginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
  remember: z.boolean().default(false),
})

export const INVALID_CREDENTIALS_MESSAGE = 'invalid username or password'

export function authRoutes(deps: Pick<AppDeps, 'db' | 'auth' | 'logger'>) {
  const auth = authServiceFor(deps)

  return new Hono<AppEnv>()
    .post('/api/auth/login', validate('json', loginSchema), async (c) => {
      const { username, password, remember } = c.req.valid('json')
      const ip = clientIp(c, auth.config.trustProxy)
      const outcome = auth.login(username, password, ip, remember)
      if (!outcome.ok) {
        // Respostas não-2xx não passam pelo audit middleware: grava direto.
        try {
          await writeAudit(deps.db, {
            actor: username,
            action: 'auth.login',
            targetType: 'auth',
            targetId: username,
            detail: { request_id: c.get('requestId'), username, success: false, reason: outcome.reason, ip },
          })
        } catch (err) {
          c.get('logger')?.error({ err }, 'failed to write audit log')
        }
        if (outcome.reason === 'rate_limited') throw new ApiError('RATE_LIMIT', 'too many failed login attempts; try again later')
        throw new ApiError('UNAUTHORIZED', INVALID_CREDENTIALS_MESSAGE)
      }
      if (remember) await rememberLogin(deps.db, outcome.result.token, auth.verify(outcome.result.token)!)
      c.set('actor', outcome.result.user.username)
      setAudit(c, { action: 'auth.login', targetType: 'auth', targetId: outcome.result.user.username, detail: { username, success: true, ip } })
      return c.json(outcome.result)
    })
    .get('/api/auth/me', (c) => {
      const token = parseBearer(c.req.header('authorization'))
      const claims = token && isLoginToken(token) ? auth.verify(token) : undefined
      if (claims) return c.json({ user: { username: claims.sub, role: claims.role }, expiresAt: new Date(claims.exp).toISOString() })
      return c.json({ user: { username: 'api_token', role: 'integration' }, expiresAt: null })
    })
    .post('/api/auth/logout', async (c) => {
      const token = parseBearer(c.req.header('authorization'))
      const claims = token && isLoginToken(token) ? auth.verify(token) : undefined
      if (token && claims?.remember) await revokeRememberedLogin(deps.db, token, claims)
      const revoked = token && isLoginToken(token) ? auth.revoke(token) : false
      setAudit(c, { action: 'auth.logout', targetType: 'auth', targetId: c.get('actor') ?? '-', detail: { revoked } })
      return c.body(null, 204)
    })
}
