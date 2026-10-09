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
      return second ? { name: 'not-found', path } : { name: head }
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
    case 'not-found':
      return `#${route.path}`
    default:
      return `#/${route.name}`
  }
}

export function navigate(route: Route): void {
  const href = routeHref(route)
  if (window.location.hash !== href) window.location.hash = href
}
