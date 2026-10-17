// Alvos RPC da integração CRM (A3, A7, A8; só com CRM_BRIDGE=on). O CRM em modo extensão (WA_RPC_PROFILE=ai-manager)
// chama estes alvos pelo mesmo `POST /internal/rpc` da API:
//  - messages.send / messages.sendGroup → SendPipeline (gates auth → sessionExists → connected → contactAllowed →
//    warmupLimit → rateLimit → enqueue) → fila → deliver com antiban. Nunca a fila crua (`messages.enqueue`).
//    Idempotência por (sessionId, clientMessageId) numa chave Redis (SET NX + TTL).
//  - media.download, presence.update: pelo transporte da sessão conectada.
//  - contacts.recordConsent / optOut (ContactsService, `public.contacts`) e contacts.list (agenda do transporte).
import { createHash } from 'node:crypto'
import {
  CONSENT_SOURCES,
  ContactsService,
  isE164,
  MediaNotFoundError,
  phoneToJid,
  SendPipeline,
  SendRejectedError,
  TransportNotConnectedError,
  type ConsentSource,
  type MessageQueue,
  type MessageView,
  type OutgoingContent,
  type PresenceKind,
  type SendRequest,
  type SessionLimitsService,
  type WaTransport,
} from '@wsm/core'
import type { Database } from '@wsm/db'
import { ClientMessageDedupe, type DedupeRedis } from './dedupe'

/** Erro de validação dos argumentos (a chamada vazia da sonda do CRM cai aqui, sem efeito colateral). */
export class BridgeValidationError extends Error {
  readonly code = 'VALIDATION_ERROR'
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export const requireString = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new BridgeValidationError(`${field} is required`)
  return v
}

export const requireObject = (v: unknown, field: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BridgeValidationError(`${field} must be an object`)
  return v as Record<string, unknown>
}

export const PRESENCE_KINDS: readonly PresenceKind[] = ['composing', 'recording', 'paused']

/** Pedido de envio como o CRM manda (`SendRequest` do `@crm/wa-port`). */
export interface CrmSendRequest extends SendRequest {
  clientMessageId?: string
  /** Aceitos e ignorados: o transporte do ai-manager ainda não envia resposta citada nem visualização única. */
  quoted?: string
  viewOnce?: boolean
}

export interface CrmSendGroupRequest {
  sessionId: string
  groupId: string
  content: OutgoingContent
  actor: string
  clientMessageId?: string
  quoted?: string
  viewOnce?: boolean
}

export interface CrmMediaHandle {
  message_id: string
  mime?: string
  key?: string | null
  file_name?: string | null
}

export interface CrmMediaPayload {
  mime: string
  size: number
  sha256: string
  key: string | null
  /** Bytes em base64. */
  data: string
}

export interface CrmContactSummary {
  jid: string
  phone: string | null
  lid: string | null
  name: string | null
  pushName: string | null
}

export interface CrmConsentInput {
  phone: string
  source: ConsentSource
  actor?: string
  name?: string | null
}

export interface CrmOptOutInput {
  phone: string
  reason?: string
  actor?: string
}

export interface CrmBridgeTargets {
  messages: {
    send(req: Record<string, unknown>): Promise<MessageView & { clientMessageId?: string }>
    sendGroup(req: Record<string, unknown>): Promise<MessageView & { clientMessageId?: string }>
  }
  media: { download(sessionId: string, handle: Record<string, unknown>): Promise<CrmMediaPayload> }
  presence: { update(sessionId: string, to: string, kind: unknown): Promise<void> }
  contacts: {
    recordConsent(input: Record<string, unknown>): Promise<void>
    optOut(input: Record<string, unknown>): Promise<void>
    list(sessionId: string): Promise<CrmContactSummary[]>
  }
}

export interface CreateCrmBridgeOptions {
  db: Database
  queue: Pick<MessageQueue, 'enqueue' | 'get'>
  /** Transporte vivo da sessão; `undefined` se a sessão não estiver conectada. */
  getTransport: (sessionId: string) => WaTransport | undefined
  /** Os MESMOS limites do worker (warm-up e taxa por sessão). */
  limits?: SessionLimitsService
  redis: DedupeRedis
  /** Prefixo das chaves Redis (QUEUE_PREFIX, `wsm`). */
  prefix?: string
  idempotencyTtlSeconds?: number
  /** Pipeline pronto (testes). Default: SendPipeline com db, fila, limites e transporte. */
  pipeline?: Pick<SendPipeline, 'send' | 'sendGroup'>
}

const MEDIA_KEYS = ['image', 'video', 'audio', 'document', 'sticker'] as const
const hasUrl = (v: unknown) => !!v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string' && !!(v as { url: string }).url.trim()

/** Só o que o transporte do ai-manager sabe enviar (texto, imagem, vídeo, áudio, documento, figurinha). */
export function assertSupportedContent(content: unknown): asserts content is OutgoingContent {
  const c = content as Record<string, unknown> | null
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new SendRejectedError('VALIDATION_ERROR', 'content must be an object')
  if (typeof c.text === 'string') {
    if (!c.text.trim() || c.text.length > 4096) throw new SendRejectedError('VALIDATION_ERROR', 'text must have 1..4096 characters')
    return
  }
  const kind = MEDIA_KEYS.find((k) => Object.hasOwn(c, k))
  if (!kind) throw new SendRejectedError('VALIDATION_ERROR', 'unsupported content (ai-manager sends text, image, video, audio, document and sticker)')
  if (!hasUrl(c[kind])) throw new SendRejectedError('VALIDATION_ERROR', `${kind}.url is required`)
  if (kind === 'document' && (typeof c.mimetype !== 'string' || !c.mimetype.trim())) throw new SendRejectedError('VALIDATION_ERROR', 'document.mimetype is required')
}

const optionalString = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

export function createCrmBridgeTargets(opts: CreateCrmBridgeOptions): CrmBridgeTargets {
  const contacts = new ContactsService(opts.db)
  const dedupe = new ClientMessageDedupe(opts.redis, { ...(opts.prefix ? { prefix: opts.prefix } : {}), ...(opts.idempotencyTtlSeconds ? { ttlSeconds: opts.idempotencyTtlSeconds } : {}) })
  const pipeline = opts.pipeline ?? buildPipeline(opts)
  const lookup = (id: string) => opts.queue.get(id)
  const withClientId = (view: MessageView, clientMessageId: string | undefined) => (clientMessageId ? { ...view, clientMessageId } : view)

  const transportOf = (sessionId: string): WaTransport => {
    const t = opts.getTransport(sessionId)
    if (!t) throw new TransportNotConnectedError()
    return t
  }

  return {
    messages: {
      send: async (input) => {
        const sessionId = String(input.sessionId ?? '')
        const clientMessageId = optionalString(input.clientMessageId)
        const req: SendRequest = { sessionId, phone: String(input.phone ?? ''), content: input.content as OutgoingContent }
        if (typeof input.actor === 'string') req.actor = input.actor
        if (typeof input.contactId === 'string') req.contactId = input.contactId
        if (typeof input.groupId === 'string') req.groupId = input.groupId
        return withClientId(await dedupe.run(sessionId, clientMessageId, () => pipeline.send(req), lookup), clientMessageId)
      },
      sendGroup: async (input) => {
        const sessionId = String(input.sessionId ?? '')
        const clientMessageId = optionalString(input.clientMessageId)
        const send = () => pipeline.sendGroup({ sessionId, groupId: String(input.groupId ?? ''), content: input.content as OutgoingContent, actor: typeof input.actor === 'string' ? input.actor : '' })
        return withClientId(await dedupe.run(sessionId, clientMessageId, send, lookup), clientMessageId)
      },
    },
    media: {
      download: async (sessionId, handle) => {
        const messageId = requireString(handle.message_id, 'message_id')
        const transport = transportOf(sessionId)
        if (!transport.downloadMedia) throw new MediaNotFoundError(messageId)
        const media = await transport.downloadMedia(messageId)
        const mime = optionalString(handle.mime) ?? media.mime
        return {
          mime,
          size: media.data.byteLength,
          sha256: createHash('sha256').update(media.data).digest('hex'),
          key: optionalString(handle.key) ?? null,
          data: media.data.toString('base64'),
        }
      },
    },
    presence: {
      update: async (sessionId, to, kind) => {
        if (!PRESENCE_KINDS.includes(kind as PresenceKind)) throw new BridgeValidationError('kind must be composing, recording or paused')
        const transport = transportOf(sessionId)
        const jid = to.includes('@') ? to : phoneToJid(to)
        if (transport.sendPresence) await transport.sendPresence(jid, kind as PresenceKind)
        else if (transport.sendTyping && kind !== 'recording') await transport.sendTyping(jid, kind === 'composing')
      },
    },
    contacts: {
      recordConsent: async (input) => {
        const phone = requireString(input.phone, 'phone')
        if (!isE164(phone)) throw new BridgeValidationError('phone must be E.164 (e.g. +5511999999999)')
        const source = requireString(input.source, 'source')
        if (!(CONSENT_SOURCES as readonly string[]).includes(source)) throw new BridgeValidationError(`source must be one of ${CONSENT_SOURCES.join(', ')}`)
        await contacts.recordConsent({
          phone,
          source: source as ConsentSource,
          ...(typeof input.actor === 'string' ? { actor: input.actor } : {}),
          ...(typeof input.name === 'string' ? { name: input.name } : {}),
        })
      },
      optOut: async (input) => {
        const phone = requireString(input.phone, 'phone')
        if (!isE164(phone)) throw new BridgeValidationError('phone must be E.164 (e.g. +5511999999999)')
        await contacts.recordOptOut(phone, {
          keyword: optionalString(input.reason) ?? 'crm',
          source: 'crm',
          ...(typeof input.actor === 'string' ? { actor: input.actor } : {}),
        })
      },
      list: async (sessionId) => {
        const transport = transportOf(sessionId)
        const list = (await transport.listContacts?.()) ?? []
        return list.map((c) => ({ jid: c.jid, phone: c.phone ?? null, lid: c.lid ?? null, name: c.name ?? null, pushName: c.pushName ?? null }))
      },
    },
  }
}

/** SendPipeline do worker + checagem do conteúdo logo antes do enqueue (depois de todos os gates de segurança). */
function buildPipeline(opts: CreateCrmBridgeOptions): SendPipeline {
  const base = new SendPipeline({ db: opts.db, queue: opts.queue, getTransport: opts.getTransport, ...(opts.limits ? { limits: opts.limits } : {}) })
  return new SendPipeline({
    db: opts.db,
    queue: opts.queue,
    getTransport: opts.getTransport,
    limits: base.limits,
    gates: {
      enqueue: async (req, ctx) => {
        assertSupportedContent(req.content)
        await base.gates.enqueue(req, ctx)
      },
    },
  })
}
