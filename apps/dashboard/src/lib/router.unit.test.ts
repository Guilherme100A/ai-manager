import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { navigate, navigateLink, parseHash, routeHref, subscribeRoute, type Route } from './router'

describe('rotas por hash', () => {
  it.each<[string, Route]>([
    ['', { name: 'home' }],
    ['#', { name: 'home' }],
    ['#/', { name: 'home' }],
    ['#/login', { name: 'login' }],
    ['#/sessions', { name: 'sessions' }],
    ['#/sessions/', { name: 'sessions' }],
    ['#/sessions/new', { name: 'new-session' }],
    ['#/sessions/abc-123', { name: 'session', id: 'abc-123' }],
    ['#/proxies', { name: 'proxies' }],
    ['#/contacts', { name: 'contacts' }],
    ['#/groups', { name: 'groups' }],
    ['#/alerts', { name: 'alerts' }],
    ['#/report', { name: 'report' }],
    ['#/autoreply', { name: 'autoreply' }],
    ['#/nope', { name: 'not-found', path: '/nope' }],
    ['#/sessions/a/b', { name: 'not-found', path: '/sessions/a/b' }],
  ])('%s', (hash, route) => expect(parseHash(hash)).toEqual(route))

  it('routeHref é o inverso de parseHash', () => {
    const routes: Route[] = [
      { name: 'home' },
      { name: 'login' },
      { name: 'sessions' },
      { name: 'new-session' },
      { name: 'session', id: 'x y' },
      { name: 'proxies' },
      { name: 'contacts' },
      { name: 'groups' },
      { name: 'alerts' },
    ]
    for (const r of routes) expect(parseHash(routeHref(r))).toEqual(r)
  })
})

describe('navegação e notificações da store', () => {
  let browser: EventTarget & { location: { hash: string }; history: { pushState: ReturnType<typeof vi.fn> } }
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    browser = Object.assign(new EventTarget(), {
      location: { hash: '#/crm' },
      history: { pushState: vi.fn((_state: unknown, _title: string, href: string) => { browser.location.hash = href }) },
    })
    vi.stubGlobal('window', browser)
  })
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    vi.unstubAllGlobals()
  })

  it('notifica todos os consumidores com a URL nova antes de retornar, sem entrada duplicada', () => {
    const snapshots: string[] = []
    const other = vi.fn()
    cleanups.push(subscribeRoute(() => snapshots.push(browser.location.hash)), subscribeRoute(other))
    for (const route of [{ name: 'home' }, { name: 'sessions' }, { name: 'session-links' }, { name: 'spy' }, { name: 'crm' }] as Route[]) {
      navigate(route)
      expect(snapshots.at(-1)).toBe(routeHref(route))
    }
    navigate({ name: 'crm' })
    expect(snapshots).toEqual(['#/', '#/sessions', '#/session-links', '#/spy', '#/crm'])
    expect(other).toHaveBeenCalledTimes(5)
    expect(browser.history.pushState).toHaveBeenCalledTimes(5)
  })

  it('observa hashchange e popstate nativos e remove a assinatura de todas as fontes', () => {
    const snapshots: string[] = []
    const unsubscribe = subscribeRoute(() => snapshots.push(browser.location.hash))
    cleanups.push(unsubscribe)
    browser.location.hash = '#/sessions'
    browser.dispatchEvent(new Event('hashchange'))
    browser.location.hash = '#/crm'
    browser.dispatchEvent(new Event('popstate'))
    expect(snapshots).toEqual(['#/sessions', '#/crm'])
    unsubscribe()
    navigate({ name: 'home' })
    browser.dispatchEvent(new Event('hashchange'))
    browser.dispatchEvent(new Event('popstate'))
    expect(snapshots).toEqual(['#/sessions', '#/crm'])
  })

  function click(overrides: Record<string, unknown> = {}) {
    return {
      defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      currentTarget: { target: '', hasAttribute: () => false }, preventDefault: vi.fn(), ...overrides,
    } as unknown as Parameters<typeof navigateLink>[0]
  }

  it('intercepta o clique primário na mesma aba e mantém a rota de retorno', () => {
    const event = click()
    navigateLink(event, { name: 'session', id: 'chip 1' })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(browser.location.hash).toBe('#/sessions/chip%201')
  })

  it.each([
    { defaultPrevented: true }, { button: 1 }, { button: 2 },
    { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true },
    { currentTarget: { target: '_blank', hasAttribute: () => false } },
    { currentTarget: { target: 'other-window', hasAttribute: () => false } },
    { currentTarget: { target: '', hasAttribute: (name: string) => name === 'download' } },
  ])('preserva o comportamento nativo: %j', (overrides) => {
    const event = click(overrides)
    navigateLink(event, { name: 'home' })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(browser.history.pushState).not.toHaveBeenCalled()
  })
})
