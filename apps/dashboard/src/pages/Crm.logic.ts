// Estado da página CRM (integração): SSO pedido ao abrir; 501 = integração desligada no servidor.
import { ApiRequestError } from '../lib/api'
import type { Route } from '../lib/router'

/** Fixed CRM destination for a Meta callback. Never accept a redirect path from the query. */
export function metaProfilesDestination(search: string): string | undefined {
  const input = new URLSearchParams(search)
  const status = input.get('meta_oauth')
  if (status !== 'success' && status !== 'error') return undefined
  const params = new URLSearchParams({ meta_oauth: status })
  const workspace = input.get('meta_workspace')
  if (workspace && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(workspace)) {
    params.set('meta_workspace', workspace)
  }
  return '/facebook/profiles?' + params
}

export type CrmState =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }

/** Erro do POST /api/crm/sso → estado da página. */
export function crmErrorState(err: unknown): CrmState {
  if (err instanceof ApiRequestError && err.status === 501) return { kind: 'disabled' }
  if (err instanceof ApiRequestError && err.status === 403) return { kind: 'error', message: 'O CRM exige o login do painel (o token de integração não abre o CRM).' }
  const message = err instanceof Error ? err.message : String(err)
  return { kind: 'error', message: `Não foi possível abrir o CRM: ${message}` }
}

/** Só URLs do mesmo origin (caminho relativo como /crm/…) ou http(s) entram no iframe. */
export function safeCrmUrl(url: string): string | undefined {
  if (url.startsWith('/') && !url.startsWith('//')) return url
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

/** A fragment token does not invalidate a cached HTML document. Fetch a fresh entry on every SSO. */
export function freshCrmUrl(url: string, nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`): string | undefined {
  const safe = safeCrmUrl(url)
  if (!safe) return undefined
  const hash = safe.indexOf('#')
  const path = hash < 0 ? safe : safe.slice(0, hash)
  const fragment = hash < 0 ? '' : safe.slice(hash)
  return `${path}${path.includes('?') ? '&' : '?'}crm_entry=${encodeURIComponent(nonce)}${fragment}`
}

/** SSO returned by our API may replace this tab only at the CRM's fixed entry. */
export function crmEntryUrl(url: string, target?: string): string | undefined {
  const fresh = freshCrmUrl(url)
  if (!fresh || !fresh.startsWith('/crm/auth/sso?')) return undefined
  return target ? `${fresh}&redirect=${encodeURIComponent(target)}` : fresh
}

/**
 * Para onde o "Voltar ao painel" leva: a última página do painel antes de entrar no CRM (ou o início, quando o CRM foi
 * aberto direto). Nunca volta para o próprio CRM nem para o login.
 */
export function backRoute(last: Route | null | undefined): Route {
  if (!last || last.name === 'crm' || last.name === 'login' || last.name === 'not-found') return { name: 'home' }
  return last
}
