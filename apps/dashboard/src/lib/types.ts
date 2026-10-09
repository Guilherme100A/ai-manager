// Formatos das respostas da API (espelham as views do @wsm/core; duplicados para não levar o core ao bundle).
export type SessionState = 'NEW' | 'WARMING' | 'STABLE' | 'DEGRADED' | 'PAUSED' | 'DISCONNECTED'
export type MessageStatus = 'queued' | 'processing' | 'sent' | 'delivered' | 'read' | 'failed' | 'retrying' | 'cancelled'
export type HealthLabel = 'Good' | 'Warning' | 'Critical'

export interface Session {
  id: string
  name: string
  /** Null até a sessão conectar pela primeira vez (cadastro por QR sem número). */
  phone: string | null
  status: SessionState
  state: SessionState
  proxyId: string | null
  /** Proxy da sessão (T17). A senha nunca vem na resposta. */
  proxy?: SessionProxy | null
  note: string | null
  requiresRestart: boolean
  warmupStartedAt: string | null
  lastConnectedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SessionHealth {
  state: SessionState
  warmupPercent: number
  score: number
  label: HealthLabel
  sent: number
  received: number
  failed: number
  disconnects: number
  forbidden403: number
  lastEventAt: string | null
}

export interface QrInfo {
  qr: string | null
  generatedAt: string | null
}

export interface Message {
  id: string
  sessionId: string
  contactId: string | null
  phone: string
  content: unknown
  status: MessageStatus
  attempts: number
  lastError: string | null
  transportMessageId: string | null
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  createdAt: string
  updatedAt: string
}

export interface MessageEvent {
  id: number
  messageId: string
  from: MessageStatus | null
  to: MessageStatus
  detail: unknown
  createdAt: string
}

export type ProxyProtocol = 'http' | 'https' | 'socks5'

/** Proxy embutido na view da sessão (AC-T17-05). */
export interface SessionProxy {
  id: string
  protocol: ProxyProtocol
  host: string
  port: number
  username: string | null
  hasPassword: boolean
}

export interface AuthUser {
  username: string
  role: string
}

export interface LoginResult {
  token: string
  expiresAt: string
  user: AuthUser
}

export interface Contact {
  id: string
  name: string | null
  phone: string
  consent: boolean
  consent_at: string | null
  consent_source: string | null
  opt_out: boolean
  last_contact_at: string | null
  created_at: string
  updated_at: string
}

export interface ImportResult {
  imported: number
  rejected: Array<{ line: number; phone: string | null; reason: string; message: string }>
  contacts: Contact[]
}

export interface Group {
  id: string
  name: string
  participants: number
  status: string
  announce: boolean
  communityId: string | null
}

export type WebhookChannel = 'discord' | 'telegram' | 'email' | 'http'

export interface Webhook {
  id: string
  name: string
  channel: WebhookChannel
  url: string
  config: Record<string, unknown>
  events: string[]
  enabled: boolean
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

export const ALERT_EVENTS = ['forbidden_403', 'disconnected', 'error_burst', 'proxy_unavailable', 'warmup_paused', 'health_degraded'] as const
export interface SessionLink {
  id: string
  sourceSessionId: string
  targetSessionId: string
  enabled: boolean
  rules: { matchText: string; replyText: string }
}

export interface SessionRouteRun {
  linkId: string
  inboundId: string
  status: string
  messageId: string | null
  error: string | null
}

/** Relatório diário (GET /api/reports/daily): "agora" por chip + uma linha por chip e dia (Brasília). */
export interface ReportChipNow {
  sessionId: string
  name: string
  phone: string | null
  status: SessionState
  proxy: boolean
  score: number
  label: HealthLabel
  warmupDay: number
  warmupPercent: number
  dailyLimit: number | null
  lastConnectedAt: string | null
}

export interface ReportDayRow {
  day: string
  sessionId: string
  sent: number
  failed: number
  received: number
  disconnects: number
  disconnectCodes: Record<string, number>
  proxyUnavailable: number
  degraded: number
  recovered: number
  blocked: number
  groupsJoined: number
  groupsPending: number
  groupsRejected: number
  groupsDiscovered: number
  /** Quedas até 60 s depois de um travamento do worker. */
  disconnectsNearStall: number
}

export interface ReportWorkerDay {
  day: string
  stalls: number
  maxLagMs: number
}

export interface ReportStall {
  at: string
  lagMs: number
  heapMb: number | null
  activity: Record<string, number>
}

export interface DailyReport {
  generatedAt: string
  days: string[]
  chips: ReportChipNow[]
  rows: ReportDayRow[]
  worker: ReportWorkerDay[]
  recentStalls: ReportStall[]
}

/** Mensagens por chip (GET /api/reports/message-counts): enviadas ao WhatsApp e recebidas. */
export interface SessionMessageCounts {
  sentTotal: number
  receivedTotal: number
  sent24h: number
  received24h: number
}

/** Número de autoresposta (próprio do operador) usado pelas conversas dos chips com proxy. */
export interface AutoReplyTarget {
  id: string
  phone: string
  createdAt: string
  sent24h: number
  replies24h: number
  lastSentAt: string | null
}
