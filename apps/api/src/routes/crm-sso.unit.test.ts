// POST /api/crm/sso (integração CRM): JWT HS256 de 120 s para o CRM no iframe; 501 sem CRM_SSO_SECRET.
import { describe, expect, it } from 'vitest'
import { decode, verify } from 'hono/jwt'
import { createApp } from '../app'
import { captureLogger, fakeDb, fakeRedis } from '../test-utils'
import { crmPublicPath } from './crm-sso'

const API_TOKEN = 'integration-token'
const SECRET = 'crm-sso-secret-0123456789abcdef0123456789'
const NOW = Date.parse('2026-10-17T12:00:00Z')

function setup(crmEnv: Record<string, string | undefined>) {
  const { db, audits } = fakeDb()
  const app = createApp({
    db,
    redis: fakeRedis(),
    logger: captureLogger().logger,
    apiToken: API_TOKEN,
    auth: { secret: 'shared-secret-0123456789', username: 'admin', password: 'nimda', now: () => new Date(NOW) },
    crmEnv,
    crmNow: () => NOW,
  })
  const loginToken = async () => {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'nimda' }) })
    return ((await res.json()) as { token: string }).token
  }
  const sso = (token?: string) => app.request('/api/crm/sso', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} })
  return { loginToken, sso, audits }
}

describe('POST /api/crm/sso', () => {
  it('login do painel → { token, url } com as claims combinadas, assinado com CRM_SSO_SECRET', async () => {
    const { loginToken, sso, audits } = setup({ CRM_SSO_SECRET: SECRET })
    const res = await sso(await loginToken())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; url: string }
    expect(body.url).toBe(`/crm/auth/sso#token=${body.token}`)
    const { header, payload } = decode(body.token)
    expect(header).toMatchObject({ alg: 'HS256', typ: 'JWT' })
    const iat = Math.floor(NOW / 1000)
    expect(payload).toEqual({
      iss: 'ai-manager',
      aud: 'crm',
      sub: 'ai-manager:admin',
      name: 'admin',
      email: 'admin@ai-manager.local',
      iat,
      exp: iat + 120,
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    // Assinatura confere com o segredo (verificação feita como o CRM fará: HS256 + iss/aud), no instante do token.
    const realNow = Date.now
    Date.now = () => NOW + 1000
    try {
      await expect(verify(body.token, SECRET, { alg: 'HS256', iss: 'ai-manager', aud: 'crm' })).resolves.toMatchObject({ sub: 'ai-manager:admin' })
      await expect(verify(body.token, `${SECRET}x`, 'HS256')).rejects.toThrow()
    } finally {
      Date.now = realNow
    }
    // jti novo a cada pedido; auditoria sem o token.
    const again = (await (await sso(await loginToken())).json()) as { token: string }
    expect(decode(again.token).payload.jti).not.toBe(payload.jti)
    const audit = audits.find((a) => a.action === 'crm.sso')
    expect(audit).toMatchObject({ actor: 'admin', targetType: 'crm', targetId: 'admin' })
    expect(JSON.stringify(audits)).not.toContain(body.token)
  })

  it('CRM_PUBLIC_PATH muda a url', async () => {
    const { loginToken, sso } = setup({ CRM_SSO_SECRET: SECRET, CRM_PUBLIC_PATH: '/apps/crm' })
    const body = (await (await sso(await loginToken())).json()) as { token: string; url: string }
    expect(body.url).toBe(`/apps/crm/auth/sso#token=${body.token}`)
    expect(crmPublicPath(undefined)).toBe('/crm/')
    expect(crmPublicPath('crm')).toBe('/crm/')
    expect(crmPublicPath('https://crm.example.com/')).toBe('https://crm.example.com/')
  })

  it('sem CRM_SSO_SECRET → 501; sem login → 401; API_TOKEN de integração → 403', async () => {
    const off = setup({})
    const disabled = await off.sso(await off.loginToken())
    expect(disabled.status).toBe(501)
    expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe('NOT_IMPLEMENTED')

    const on = setup({ CRM_SSO_SECRET: SECRET })
    expect((await on.sso()).status).toBe(401)
    expect((await on.sso('wsm1.bad.token')).status).toBe(401)
    const integration = await on.sso(API_TOKEN)
    expect(integration.status).toBe(403)
    expect(((await integration.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })
})
