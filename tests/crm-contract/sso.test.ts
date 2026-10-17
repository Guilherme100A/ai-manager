// O token de POST /api/crm/sso passa no verifySsoToken do CRM (@crm/core), o mesmo usado em POST /api/auth/sso.
import { describe, expect, it } from 'vitest'
import { createApp } from '../../apps/api/src/app'
import { captureLogger, fakeDb, fakeRedis } from '../../apps/api/src/test-utils'
import { verifySsoToken } from '@crm-copy/packages/core/src/auth/sso-token.ts'

const SECRET = 'segredo-sso-compartilhado-0123456789abcdef'

describe('SSO ai-manager → CRM', () => {
  it('token emitido pelo ai-manager é aceito pelo CRM; segredo diferente é recusado', async () => {
    const app = createApp({
      db: fakeDb().db,
      redis: fakeRedis(),
      logger: captureLogger().logger,
      apiToken: 'integration-token',
      auth: { secret: 'shared-secret-0123456789', username: 'admin', password: 'nimda' },
      crmEnv: { CRM_SSO_SECRET: ` ${SECRET} ` },
    })
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'nimda' }) })
    const { token: loginToken } = (await login.json()) as { token: string }
    const res = await app.request('/api/crm/sso', { method: 'POST', headers: { authorization: `Bearer ${loginToken}` } })
    const { token, url } = (await res.json()) as { token: string; url: string }
    expect(url).toBe(`/crm/auth/sso#token=${token}`)
    expect(verifySsoToken(token, SECRET)).toMatchObject({ iss: 'ai-manager', aud: 'crm', sub: 'ai-manager:admin', name: 'admin', email: 'admin@ai-manager.local' })
    expect(() => verifySsoToken(token, `${SECRET}-outro`)).toThrow(expect.objectContaining({ code: 'bad_signature' }))
  })
})
