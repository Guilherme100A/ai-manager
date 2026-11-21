import { describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '../lib/api'
import { parseHash, routeHref } from '../lib/router'
import { createCrmAttempt, backRoute, crmEntryUrl, crmErrorState, freshCrmUrl, metaProfilesDestination, safeCrmUrl } from './Crm.logic'

describe('página CRM', () => {
  it('keeps only the validated OAuth result and workspace on the fixed CRM destination', () => {
    const area = '11111111-2222-4333-8444-555555555555'
    expect(metaProfilesDestination('?meta_oauth=success&meta_workspace=' + area + '&redirect=//other.example&code=private'))
      .toBe('/facebook/profiles?meta_oauth=success&meta_workspace=' + area)
    expect(metaProfilesDestination('?meta_oauth=error&meta_workspace=%2F%2Fother.example'))
      .toBe('/facebook/profiles?meta_oauth=error')
    expect(metaProfilesDestination('?meta_oauth=invalid')).toBeUndefined()
  })
  it('renews the document URL without putting the SSO token in the HTTP query', () => {
    expect(freshCrmUrl('/crm/auth/sso#token=private', 'one')).toBe('/crm/auth/sso?crm_entry=one#token=private')
    expect(freshCrmUrl('/crm/auth/sso?embed=1#token=private&redirect=%2Fflows', 'two')).toBe('/crm/auth/sso?embed=1&crm_entry=two#token=private&redirect=%2Fflows')
    expect(freshCrmUrl('https://crm.example/auth/sso#token=private', 'three')).toBe('https://crm.example/auth/sso?crm_entry=three#token=private')
    expect(freshCrmUrl('javascript:alert(1)', 'four')).toBeUndefined()
    expect(freshCrmUrl('//example.com', 'five')).toBeUndefined()
  })
  it('replaces the tab only at the fixed same-origin CRM SSO entry', () => {
    expect(crmEntryUrl('/crm/auth/sso#token=private', '/flows')).toMatch(/^\/crm\/auth\/sso\?crm_entry=.*#token=private&redirect=%2Fflows$/)
    expect(crmEntryUrl('https://elsewhere.example/auth/sso#token=private')).toBeUndefined()
    expect(crmEntryUrl('/crm/flows#token=private')).toBeUndefined()
  })
  it('rota #/crm', () => {
    expect(parseHash('#/crm')).toEqual({ name: 'crm' })
    expect(routeHref({ name: 'crm' })).toBe('#/crm')
    expect(parseHash('#/crm/x')).toEqual({ name: 'crm', flowId: 'x' })
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

  it('Voltar ao painel: última página do painel, ou o início', () => {
    expect(backRoute(null)).toEqual({ name: 'home' })
    expect(backRoute({ name: 'sessions' })).toEqual({ name: 'sessions' })
    expect(backRoute({ name: 'session', id: 's1' })).toEqual({ name: 'session', id: 's1' })
    expect(backRoute({ name: 'crm' })).toEqual({ name: 'home' })
    expect(backRoute({ name: 'login' })).toEqual({ name: 'home' })
    expect(backRoute({ name: 'not-found', path: '/x' })).toEqual({ name: 'home' })
    expect(routeHref(backRoute({ name: 'groups' }))).toBe('#/groups')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('CRM attempts with deferred responses', () => {
  it('shares repeated clicks, invalidates old responses and allows a fresh attempt', async () => {
    const old = deferred<{ url: string }>(), next = deferred<{ url: string }>()
    const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const replace = vi.fn(), report = vi.fn()
    const controller = createCrmAttempt(request, replace, report)
    const first = controller.start()
    expect(controller.start()).toBe(first)
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
    controller.invalidate()
    const second = controller.start()
    next.resolve({ url: '/crm/auth/sso#token=new' })
    await second
    old.resolve({ url: '/crm/auth/sso#token=old' })
    await first
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace.mock.calls[0]?.[0]).toContain('#token=new')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('ignores rejected responses after unmount and retries invalid URLs', async () => {
    const old = deferred<{ url: string }>()
    const report = vi.fn(), replace = vi.fn()
    const controller = createCrmAttempt(() => old.promise, replace, report)
    const pending = controller.start()
    controller.invalidate()
    old.reject(new Error('late'))
    await pending
    expect(report).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
    const request = vi.fn().mockResolvedValueOnce({ url: '//other.example' }).mockResolvedValueOnce({ url: '/crm/auth/sso#token=ok' })
    const retry = createCrmAttempt(request, replace, report, '/flows/one/edit')
    await retry.start()
    expect(report).toHaveBeenLastCalledWith({ kind: 'error', message: expect.stringContaining('inválida') })
    await retry.start()
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('&redirect=%2Fflows%2Fone%2Fedit'))
  })
  it.each([501, 403, 500])('reports %s and makes exactly one new request on retry', async (status) => {
    const request = vi.fn().mockRejectedValueOnce(new ApiRequestError(status, 'SSO_ERROR', 'off')).mockResolvedValueOnce({ url: '/crm/auth/sso#token=ok' })
    const report = vi.fn(), replace = vi.fn()
    const controller = createCrmAttempt(request, replace, report)
    await controller.start()
    expect(report).toHaveBeenLastCalledWith(crmErrorState(new ApiRequestError(status, 'SSO_ERROR', 'off')))
    await controller.start()
    expect(request).toHaveBeenCalledTimes(2)
    expect(replace).toHaveBeenCalledTimes(1)
  })
})
