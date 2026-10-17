// POST /api/crm/sso (integração CRM): o painel abre o CRM (servido no mesmo origin em CRM_PUBLIC_PATH, default /crm/)
// num iframe já logado. Exige o login do painel (token de login; API_TOKEN de integração não serve) e devolve
// `{ token, url }`: JWT HS256 de vida curta (120 s) assinado com CRM_SSO_SECRET, que o CRM troca por uma sessão
// em `<CRM_PUBLIC_PATH>auth/sso#token=<token>` (no fragmento: não vai para logs de proxy nem para o Referer).
// Sem CRM_SSO_SECRET a rota responde 501 (integração desligada).
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'

declare module '../types' {
  interface AppDeps {
    /** Ambiente da integração CRM (CRM_SSO_SECRET, CRM_PUBLIC_PATH). Default process.env, lido a cada pedido. */
    crmEnv?: Record<string, string | undefined>
    /** Relógio (testes). */
    crmNow?: () => number
  }
}

export const CRM_SSO_TTL_SECONDS = 120
export const CRM_SSO_ISSUER = 'ai-manager'
export const CRM_SSO_AUDIENCE = 'crm'

/** Actors que não são um usuário do painel (integrações e rota pública). */
const NON_USER_ACTORS = new Set(['api_token', 'anonymous'])

/** Normaliza o caminho público do CRM: começa e termina com `/`. */
export function crmPublicPath(raw: string | undefined): string {
  const path = raw?.trim() || '/crm/'
  const withStart = path.startsWith('/') || /^https?:\/\//.test(path) ? path : `/${path}`
  return withStart.endsWith('/') ? withStart : `${withStart}/`
}

export function crmSsoRoutes(deps: Pick<AppDeps, 'crmEnv' | 'crmNow'>) {
  return new Hono<AppEnv>().post('/api/crm/sso', async (c) => {
    const env = deps.crmEnv ?? process.env
    const secret = env.CRM_SSO_SECRET
    if (!secret?.trim()) throw new ApiError('NOT_IMPLEMENTED', 'CRM integration is disabled (CRM_SSO_SECRET not set)')
    const username = c.get('actor')
    if (!username || NON_USER_ACTORS.has(username)) throw new ApiError('FORBIDDEN', 'CRM SSO requires a dashboard login')
    const iat = Math.floor((deps.crmNow?.() ?? Date.now()) / 1000)
    const jti = randomUUID()
    const token = await sign(
      {
        iss: CRM_SSO_ISSUER,
        aud: CRM_SSO_AUDIENCE,
        sub: `ai-manager:${username}`,
        name: username,
        email: `${username}@ai-manager.local`,
        iat,
        exp: iat + CRM_SSO_TTL_SECONDS,
        jti,
      },
      secret,
      'HS256',
    )
    setAudit(c, { action: 'crm.sso', targetType: 'crm', targetId: username, detail: { jti } })
    return c.json({ token, url: `${crmPublicPath(env.CRM_PUBLIC_PATH)}auth/sso#token=${token}` })
  })
}
