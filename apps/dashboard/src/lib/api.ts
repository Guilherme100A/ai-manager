// Cliente da API: sempre por caminhos relativos (/api, /metrics), mesma origem do dashboard.
import { clearToken, getToken } from './auth'
import type { ProxyInput } from './proxy-form'
import type {
  AuthUser,
  Contact,
  DailyReport,
  Group,
  ImportResult,
  LoginResult,
  Message,
  MessageEvent,
  MessageStatus,
  QrInfo,
  Session,
  SessionLink,
  SessionRouteRun,
  SessionHealth,
  Webhook,
  WebhookChannel,
} from './types'

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

/** Limite de chips por IP: ligado, no máximo `maxSessionsPerIp` sessões no mesmo IP/porta de proxy. */
export interface ProxySharing { enabled: boolean; maxSessionsPerIp: number }

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface RequestOptions {
  method?: string
  body?: unknown
  /** Corpo cru (ex.: CSV) com o content-type dado. */
  raw?: { body: string; contentType: string }
  /** Token explícito (login); default: token salvo. */
  token?: string
  /** Não limpa o token num 401 (usado no login). */
  keepTokenOn401?: boolean
}

let fetchImpl: FetchFn = (input, init) => globalThis.fetch(input, init)

/** Troca o fetch (testes). */
export function setFetch(fn: FetchFn): void {
  fetchImpl = fn
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = opts.token ?? getToken()
  if (token) headers.authorization = `Bearer ${token}`
  let body: string | undefined
  if (opts.raw) {
    headers['content-type'] = opts.raw.contentType
    body = opts.raw.body
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetchImpl(path, { method: opts.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = undefined
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error
    if (res.status === 401 && !opts.keepTokenOn401) clearToken()
    throw new ApiRequestError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `HTTP ${res.status}`)
  }
  return data as T
}

const enc = encodeURIComponent

export const api = {
  sessionLinks: () => request<{ items: SessionLink[] }>('/api/session-links').then((r) => r.items),
  sessionRouteRuns: () => request<{ items: SessionRouteRun[] }>('/api/session-links/runs').then((r) => r.items),
  createSessionLink: (input: Pick<SessionLink, 'sourceSessionId' | 'targetSessionId' | 'rules'>) =>
    request<SessionLink>('/api/session-links', { body: input }),
  enableSessionLink: (id: string, enabled: boolean) =>
    request<SessionLink>(`/api/session-links/${enc(id)}`, { method: 'PATCH', body: { enabled } }),
  deleteSessionLink: (id: string) => request<void>(`/api/session-links/${enc(id)}`, { method: 'DELETE' }),
  /** Login do administrador (AC-T18-01). Um 401 aqui não limpa o token salvo. */
  login: (username: string, password: string) =>
    request<LoginResult>('/api/auth/login', { body: { username, password }, keepTokenOn401: true }),
  me: () => request<{ user: AuthUser; expiresAt: string | null }>('/api/auth/me'),
  /** Revoga o token atual (204). */
  logout: () => request<void>('/api/auth/logout', { method: 'POST', keepTokenOn401: true }),

  sessions: () => request<{ items: Session[] }>('/api/sessions').then((r) => r.items),
  session: (id: string) => request<Session>(`/api/sessions/${enc(id)}`),
  createSession: (input: { name: string; phone?: string | null; proxy?: ProxyInput | null; note?: string | null }) =>
    request<Session>('/api/sessions', { body: input }),
  /** Edita a sessão (AC-T17-04). `proxy: null` remove; sem `password` mantém a senha atual. */
  updateSession: (id: string, input: { name?: string; note?: string | null; proxy?: ProxyInput | null }) =>
    request<Session>(`/api/sessions/${enc(id)}`, { method: 'PATCH', body: input }),
  startQr: (id: string) => request<Session>(`/api/sessions/${enc(id)}/qr`, { method: 'POST' }),
  getQr: (id: string) => request<QrInfo>(`/api/sessions/${enc(id)}/qr`),
  pairingCode: (id: string, phone?: string) =>
    request<{ code: string }>(`/api/sessions/${enc(id)}/pairing-code`, { body: phone ? { phone } : {} }),
  deleteSession: (id: string) => request<void>(`/api/sessions/${enc(id)}`, { method: 'DELETE' }),
  /** Limite de chips por IP do proxy (botão na página de sessões). */
  proxySharing: () => request<ProxySharing>('/api/proxy-sharing'),
  saveProxySharing: (input: ProxySharing) => request<ProxySharing>('/api/proxy-sharing', { method: 'PUT', body: input }),
  action: (id: string, action: 'pause' | 'resume' | 'restart' | 'logout') =>
    request<Session>(`/api/sessions/${enc(id)}/${action}`, { method: 'POST' }),
  health: (id: string) => request<SessionHealth>(`/api/sessions/${enc(id)}/health`),
  groups: (id: string) => request<{ items: Group[] }>(`/api/sessions/${enc(id)}/groups`).then((r) => r.items),
  refreshGroups: (id: string) => request<{ items: Group[] }>(`/api/sessions/${enc(id)}/groups/refresh`, { method: 'POST' }).then((r) => r.items),

  messages: (filter: { sessionId?: string; status?: MessageStatus; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (filter.sessionId) q.set('sessionId', filter.sessionId)
    if (filter.status) q.set('status', filter.status)
    q.set('limit', String(filter.limit ?? 500))
    return request<{ items: Message[] }>(`/api/messages?${q}`).then((r) => r.items)
  },
  messageEvents: (id: string) => request<{ items: MessageEvent[] }>(`/api/messages/${enc(id)}/events`).then((r) => r.items),

  contacts: () => request<Contact[]>('/api/contacts?limit=1000'),
  importContacts: (csv: string) => request<ImportResult>('/api/contacts/import', { raw: { body: csv, contentType: 'text/csv' } }),

  webhooks: () => request<{ items: Webhook[] }>('/api/webhooks').then((r) => r.items),
  dailyReport: (days = 7) => request<DailyReport>(`/api/reports/daily?days=${days}`),
  createWebhook: (input: { name: string; channel: WebhookChannel; url: string; secret?: string; config?: Record<string, unknown>; events?: string[] }) =>
    request<Webhook>('/api/webhooks', { body: input }),
  updateWebhook: (id: string, input: Partial<{ enabled: boolean; name: string }>) =>
    request<Webhook>(`/api/webhooks/${enc(id)}`, { method: 'PATCH', body: input }),
  deleteWebhook: (id: string) => request<void>(`/api/webhooks/${enc(id)}`, { method: 'DELETE' }),
  testWebhook: (id: string) => request<{ ok: boolean; attempts: number; error?: string }>(`/api/webhooks/${enc(id)}/test`, { method: 'POST' }),

  /** Métricas Prometheus (T15). null quando o endpoint não existe. */
  metrics: async (): Promise<string | null> => {
    try {
      const token = getToken()
      const res = await fetchImpl('/metrics', token ? { headers: { authorization: `Bearer ${token}` } } : undefined)
      if (!res.ok) return null
      return await res.text()
    } catch {
      return null
    }
  },
}
