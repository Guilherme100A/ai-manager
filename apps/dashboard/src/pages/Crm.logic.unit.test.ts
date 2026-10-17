import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '../lib/api'
import { parseHash, routeHref } from '../lib/router'
import { crmErrorState, safeCrmUrl } from './Crm.logic'

describe('página CRM', () => {
  it('rota #/crm', () => {
    expect(parseHash('#/crm')).toEqual({ name: 'crm' })
    expect(routeHref({ name: 'crm' })).toBe('#/crm')
    expect(parseHash('#/crm/x')).toEqual({ name: 'not-found', path: '/crm/x' })
  })

  it('501 → integração desligada; 403 → login do painel; resto → erro', () => {
    expect(crmErrorState(new ApiRequestError(501, 'NOT_IMPLEMENTED', 'off'))).toEqual({ kind: 'disabled' })
    expect(crmErrorState(new ApiRequestError(403, 'FORBIDDEN', 'x'))).toMatchObject({ kind: 'error', message: expect.stringContaining('login do painel') })
    expect(crmErrorState(new Error('rede'))).toEqual({ kind: 'error', message: 'Não foi possível abrir o CRM: rede' })
  })

  it('só aceita URL do mesmo origin ou http(s)', () => {
    expect(safeCrmUrl('/crm/auth/sso#token=a.b.c')).toBe('/crm/auth/sso#token=a.b.c')
    expect(safeCrmUrl('https://crm.example.com/auth/sso#token=x')).toBe('https://crm.example.com/auth/sso#token=x')
    expect(safeCrmUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeCrmUrl('//evil.example.com/')).toBeUndefined()
  })
})
