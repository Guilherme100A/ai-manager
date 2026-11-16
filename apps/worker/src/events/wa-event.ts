// WaEvent v1 (integração CRM, A1): eventos do WhatsApp no Redis Stream `wsm:events`, JSON em snake_case no fio.
// É o mesmo formato que o CRM consome (`@crm/wa-port` events.ts). Entrega at-least-once; o CRM deduplica por
// (session_id, message_id). Campos novos só por acréscimo opcional.
import type { CtwaInfo, IncomingMessage, MessageStatus, SessionState } from '@wsm/core'

export const WA_EVENT_VERSION = 1 as const
export const WA_EVENTS_STREAM = 'wsm:events'

/** Mídia de uma mensagem recebida. No ai-manager o download é sempre sob demanda (`media.download`). */
export interface WaMediaHandle {
  session_id: string
  message_id: string
  mime: string
  size: number | null
  sha256: string | null
  key: string | null
  status: 'ready' | 'pending' | 'expired' | 'failed' | 'unavailable'
  file_name?: string | null
}

export interface WaCtwaInfo {
  ctwa_clid?: string | null
  source_id?: string | null
  source_type?: string | null
  source_url?: string | null
  media_url?: string | null
  title?: string | null
  body?: string | null
}

export interface WaIncomingMessage {
  id: string
  from: string
  alt_jid?: string
  participant?: string
  from_me: boolean
  timestamp: number
  push_name?: string
  text?: string
  type: string
  media?: WaMediaHandle
  quoted_id?: string
  ad?: WaCtwaInfo
}

interface Envelope {
  v: typeof WA_EVENT_VERSION
  session_id: string
  /** ISO 8601 UTC. */
  at: string
}

export type WaEvent =
  | (Envelope & { type: 'message.inbound'; message: WaIncomingMessage })
  | (Envelope & { type: 'message.status'; message_id: string; transport_message_id?: string | null; status: MessageStatus; error?: string | null })
  | (Envelope & { type: 'session.state'; from: SessionState | null; to: SessionState })
  | (Envelope & { type: 'session.connection'; state: 'open' | 'close'; reason?: 'loggedOut' | 'forbidden' | 'transient'; status_code?: number })
  | (Envelope & { type: 'session.qr'; qr: string })
  | (Envelope & { type: 'session.pairing_code'; code: string })

export type WaEventType = WaEvent['type']

function toWaAd(ad: CtwaInfo): WaCtwaInfo {
  const out: WaCtwaInfo = { ctwa_clid: ad.ctwaClid, source_id: ad.sourceId, source_url: ad.sourceUrl }
  if (ad.sourceType) out.source_type = ad.sourceType
  if (ad.mediaUrl) out.media_url = ad.mediaUrl
  if (ad.title) out.title = ad.title
  if (ad.body) out.body = ad.body
  return out
}

/** `IncomingMessage` do transporte (camelCase) → mensagem do fio (snake_case), sem campos que a porta não tem. */
export function toWaMessage(sessionId: string, msg: IncomingMessage): WaIncomingMessage {
  const out: WaIncomingMessage = { id: msg.id, from: msg.from, from_me: msg.fromMe, timestamp: msg.timestamp, type: msg.type }
  if (msg.fromAlt) out.alt_jid = msg.fromAlt
  if (msg.participant) out.participant = msg.participant
  if (msg.pushName) out.push_name = msg.pushName
  if (msg.text !== undefined) out.text = msg.text
  if (msg.media) {
    out.media = {
      session_id: sessionId,
      message_id: msg.id,
      mime: msg.media.mime,
      size: msg.media.size,
      sha256: msg.media.sha256,
      key: null,
      status: 'pending',
      ...(msg.media.fileName ? { file_name: msg.media.fileName } : {}),
    }
  }
  if (msg.quotedId) out.quoted_id = msg.quotedId
  if (msg.ad) out.ad = toWaAd(msg.ad)
  return out
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Checagem mínima do envelope antes do XADD (o produtor monta os eventos; isto pega erro de programação). */
export function assertWaEvent(event: WaEvent): void {
  if (event.v !== WA_EVENT_VERSION) throw new Error(`invalid WaEvent version: ${String(event.v)}`)
  if (typeof event.session_id !== 'string' || !event.session_id) throw new Error('invalid WaEvent: session_id')
  if (typeof event.at !== 'string' || !ISO.test(event.at)) throw new Error('invalid WaEvent: at')
  if (event.type === 'message.inbound' && (!event.message.id || !event.message.from || !event.message.type)) {
    throw new Error('invalid WaEvent (message.inbound): message')
  }
  if (event.type === 'session.qr' && !event.qr) throw new Error('invalid WaEvent (session.qr): qr')
}
