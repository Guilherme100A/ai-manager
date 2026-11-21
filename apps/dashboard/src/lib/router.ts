import type { MouseEvent } from 'react'

// Roteamento por hash (#/...): funciona em qualquer servidor estático sem fallback.
export type Route =
  | { name: 'login' }
  | { name: 'home' }
  | { name: 'sessions' }
  | { name: 'new-session' }
  | { name: 'session'; id: string }
  | { name: 'proxies' }
  | { name: 'contacts' }
  | { name: 'groups' }
  | { name: 'alerts' }
  | { name: 'report' }
  | { name: 'autoreply' }
  | { name: 'ai' }
  | { name: 'session-links' }
  /** Espião de funil: links de anúncios → WhatsApp da oferta. */
  | { name: 'spy' }
  /** CRM (integração): o CRM do mesmo origin num iframe, com SSO do painel. */
  | { name: 'crm'; flowId?: string }
  | { name: 'not-found'; path: string }

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '') || '/'
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return { name: 'home' }
  const [head, second, ...rest] = parts
  if (rest.length > 0) return { name: 'not-found', path }
  switch (head) {
    case 'login':
      return second ? { name: 'not-found', path } : { name: 'login' }
    case 'sessions':
      if (!second) return { name: 'sessions' }
      if (second === 'new') return { name: 'new-session' }
      return { name: 'session', id: decodeURIComponent(second) }
    case 'proxies':
    case 'contacts':
    case 'groups':
    case 'alerts':
    case 'report':
    case 'autoreply':
    case 'ai':
    case 'session-links':
    case 'spy':
      return second ? { name: 'not-found', path } : { name: head }
    case 'crm':
      return second ? { name: 'crm', flowId: decodeURIComponent(second) } : { name: 'crm' }
    default:
      return { name: 'not-found', path }
  }
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/'
    case 'new-session':
      return '#/sessions/new'
    case 'session':
      return `#/sessions/${encodeURIComponent(route.id)}`
    case 'crm':
      return route.flowId ? `#/crm/${encodeURIComponent(route.flowId)}` : '#/crm'
    case 'not-found':
      return `#${route.path}`
    default:
      return `#/${route.name}`
  }
}

const listeners = new Set<() => void>()

export function subscribeRoute(cb: () => void): () => void {
  listeners.add(cb)
  window.addEventListener('hashchange', cb)
  window.addEventListener('popstate', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('hashchange', cb)
    window.removeEventListener('popstate', cb)
  }
}

export function navigate(route: Route): void {
  const href = routeHref(route)
  if (window.location.hash === href) return
  window.history.pushState(null, '', href)
  // pushState não emite eventos: a store muda no mesmo gesto, antes do próximo frame.
  for (const listener of listeners) listener()
}

/** Só intercepta navegação interna na mesma aba; mantém as demais ações nativas do link. */
export function navigateLink(event: MouseEvent<HTMLAnchorElement>, route: Route): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const link = event.currentTarget
  if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return
  event.preventDefault()
  navigate(route)
}
