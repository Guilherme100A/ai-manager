// /api/messages (T08): consulta e cancelamento de mensagens da fila.
// T09: POST /api/sessions/:id/messages enfileira passando pelo SendPipeline (gates em ordem fixa, SPEC 3.4).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { E164_REGEX, MESSAGE_STATUSES } from '@wsm/db'
import {
  ChatHistory,
  MessageNotFoundError,
  MessageStore,
  MessageTransitionError,
  SendPipeline,
  SendRejectedError,
  toMessageEventView,
  type SendQueue,
  type WaTransport,
  toMessageView,
  type MessagesControl,
} from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

declare module '../types' {
  interface AppDeps {
    /** MessageQueue do worker (T08). Opcional: sem ela, as rotas operam direto no banco. */
    messages?: MessagesControl
    /** Pipeline de envio (T09). Opcional: sem ele, a rota monta um a partir de db/messages/sessions. */
    pipeline?: Pick<SendPipeline, 'send'>
  }
}

/** Implementação só com o banco: o cancelamento vale porque o processador ignora mensagens fora de queued/retrying. */
export function dbOnlyMessages(store: MessageStore): MessagesControl {
  return {
    get: async (id) => toMessageView(await store.get(id)),
    list: async (filter) => (await store.list(filter)).map(toMessageView),
    events: async (id) => {
      await store.get(id)
      return (await store.events(id)).map(toMessageEventView)
    },
    cancel: async (id) => toMessageView((await store.cancel(id)).row),
  }
}

export const listMessagesQuery = z.object({
  sessionId: z.uuid().optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

function toApiError(err: unknown): unknown {
  if (err instanceof SendRejectedError) return new ApiError(err.code, err.message, { gate: err.gate, ...err.details })
  if (err instanceof MessageNotFoundError) return new ApiError('NOT_FOUND', err.message)
  if (err instanceof MessageTransitionError) return new ApiError('INVALID_TRANSITION', err.message, { from: err.from, to: err.to })
  return err
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

const id = (c: Context<AppEnv>) => c.req.param('id') ?? ''

const chatsQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() })
const sessionIdOf = (c: Context<AppEnv>) => {
  const sid = id(c)
  if (!z.uuid().safeParse(sid).success) throw new ApiError('SESSION_NOT_FOUND', 'Sessão inválida.')
  return sid
}

const media = z.object({ url: z.string().trim().min(1) })
const caption = z.string().max(4096).optional()
const mimetype = z.string().trim().min(1).max(200)
export const outgoingContentSchema = z.union([
  z.object({ text: z.string().min(1).max(4096) }).strict(),
  z.object({ image: media, caption, mimetype: mimetype.optional() }).strict(),
  z.object({ video: media, caption, mimetype: mimetype.optional() }).strict(),
  z.object({ audio: media, mimetype: mimetype.optional(), ptt: z.boolean().optional() }).strict(),
  z.object({ document: media, mimetype, fileName: z.string().max(255).optional(), caption }).strict(),
])
export const sendMessageSchema = z.object({
  phone: z.string().trim().regex(E164_REGEX, 'phone must be E.164 (e.g. +5511999999999)'),
  content: outgoingContentSchema,
})

const hasEnqueue = (m: unknown): m is SendQueue => typeof (m as { enqueue?: unknown } | undefined)?.enqueue === 'function'

/** Pipeline default da API: fila do T08 (deps.messages) e transporte do SessionManager (deps.sessions). */
function buildPipeline(deps: Pick<AppDeps, 'db' | 'messages' | 'sessions' | 'pipeline'>): Pick<SendPipeline, 'send'> {
  if (deps.pipeline) return deps.pipeline
  const sessions = deps.sessions as { getTransport?: (id: string) => WaTransport | undefined } | undefined
  return new SendPipeline({
    db: deps.db,
    ...(hasEnqueue(deps.messages) ? { queue: deps.messages } : {}),
    ...(sessions?.getTransport ? { getTransport: (sid: string) => sessions.getTransport!(sid) } : {}),
  })
}

export function messagesRoutes(deps: Pick<AppDeps, 'db' | 'messages' | 'sessions' | 'pipeline'>) {
  const messages = deps.messages ?? dbOnlyMessages(new MessageStore(deps.db))
  const pipeline = buildPipeline(deps)
  const chats = new ChatHistory(deps.db)

  return new Hono<AppEnv>()
    .get('/api/messages', validate('query', listMessagesQuery), async (c) => {
      const q = c.req.valid('query')
      return c.json({ items: await run(() => messages.list(q)) })
    })
    // Conversas do chip (só banco, nunca o WhatsApp): ver o histórico não gasta envio nem mexe nos limites.
    .get('/api/sessions/:id/chats', validate('query', chatsQuery), async (c) =>
      c.json({ items: await chats.list(sessionIdOf(c), c.req.valid('query').limit) }))
    .get('/api/sessions/:id/chats/:phone', validate('query', chatsQuery), async (c) => {
      const phone = c.req.param('phone') ?? ''
      if (!E164_REGEX.test(phone)) throw new ApiError('VALIDATION_ERROR', 'Número inválido.')
      return c.json({ items: await chats.messages(sessionIdOf(c), phone, c.req.valid('query').limit) })
    })
    .get('/api/messages/:id', async (c) => c.json(await run(() => messages.get(id(c)))))
    .get('/api/messages/:id/events', async (c) => c.json({ items: await run(() => messages.events(id(c))) }))
    .post('/api/sessions/:id/messages', validate('json', sendMessageSchema), async (c) => {
      const body = c.req.valid('json')
      const message = await run(() => pipeline.send({ sessionId: id(c), phone: body.phone, content: body.content, actor: c.get('actor') }))
      setAudit(c, { action: 'message.send', targetType: 'message', targetId: message.id, detail: { sessionId: message.sessionId } })
      return c.json(message, 202)
    })
    .post('/api/messages/:id/cancel', async (c) => {
      const message = await run(() => messages.cancel(id(c)))
      setAudit(c, { action: 'message.cancel', targetType: 'message', targetId: message.id, detail: { sessionId: message.sessionId } })
      return c.json(message)
    })
}
