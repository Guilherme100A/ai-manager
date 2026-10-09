import { describe, expect, it } from 'vitest'
import { parseHash, routeHref, type Route } from './router'

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
