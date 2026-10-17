// Estado da página CRM (integração): SSO pedido ao abrir; 501 = integração desligada no servidor.
import { ApiRequestError } from '../lib/api'

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
