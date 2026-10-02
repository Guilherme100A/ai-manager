// /api/sessions (T05): CRUD de leitura/criação e controle de sessões.
// A API conversa com o SessionManager do worker por `deps.sessions` (interface abaixo); sem ele,
// só criação/leitura funcionam (direto no banco) e as ações de conexão respondem 500.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { E164_REGEX } from '@wsm/db'
import {
  InvalidTransitionError,
  loadSessionProxies,
  ProxyError,
  SessionError,
  SessionStore,
  SUPPORTED_PROXY_PROTOCOLS,
  toSessionView,
  type CreateSessionInput,
  type SessionProxyView,
  type SessionView,
} from '@wsm/core'
import type { Database } from '@wsm/db'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

/** Contrato que o SessionManager (apps/worker) implementa. */
export interface SessionsControl {
  create(input: CreateSessionInput): Promise<SessionView>
  list(): Promise<SessionView[]>
  get(id: string): Promise<SessionView>
  startQr(id: string): Promise<SessionView>
  getQr(id: string): Promise<{ qr: string | null; generatedAt: string | null }>
  requestPairingCode(id: string, phone?: string): Promise<{ code: string }>
  pause(id: string): Promise<SessionView>
  resume(id: string): Promise<SessionView>
  restart(id: string): Promise<SessionView>
  logout(id: string): Promise<SessionView>
  /** Exclui a sessão (desvincula o aparelho, apaga histórico, fila e automações). */
  remove(id: string): Promise<{ deletedProxyId: string | null }>
}

declare module '../types' {
  interface AppDeps {
    /** SessionManager do worker (T05). Opcional: sem ele, ações de conexão ficam indisponíveis. */
    sessions?: SessionsControl
  }
}

const phone = z.string().trim().regex(E164_REGEX, 'phone must be E.164 (e.g. +5511999999999)')
const optionalText = z.string().trim().max(2000).nullable().optional()

/** T17: proxy informado junto com a sessão. No PATCH, `password` ausente mantém a senha atual; null remove. */
export const inlineProxySchema = z.object({
  protocol: z.enum(SUPPORTED_PROXY_PROTOCOLS),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).nullable().optional(),
  password: z.string().max(1024).nullable().optional(),
})

export const createSessionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    // Opcional: no QR o worker preenche com o número da conta ao conectar. O pairing code exige número.
    phone: phone.nullable().optional(),
    proxyId: z.uuid().nullable().optional(),
    note: optionalText,
    proxy: inlineProxySchema.nullable().optional(),
  })
  .refine((b) => !(b.proxy && b.proxyId), { path: ['proxy'], message: 'use either proxy or proxyId, not both' })

export const updateSessionSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    note: optionalText,
    proxy: inlineProxySchema.nullable().optional(),
    /** Não aceito no PATCH: o proxy é editado inline. */
    proxyId: z.unknown().optional(),
  })
  .refine((b) => b.proxyId === undefined, { path: ['proxyId'], message: 'proxyId is not accepted here; send proxy instead' })
  .refine((b) => b.name !== undefined || b.note !== undefined || b.proxy !== undefined, { message: 'nothing to update (name, note or proxy)' })

/** SessionView + proxy da sessão (sem senha). */
export type SessionWithProxy = SessionView & { proxy: SessionProxyView | null }

/** Acrescenta `proxy` às views (uma consulta; nenhuma quando nenhuma sessão tem proxy). */
export async function withProxies(db: Database, views: SessionView[]): Promise<SessionWithProxy[]> {
  const map = await loadSessionProxies(db, views.map((v) => v.proxyId))
  return views.map((v) => ({ ...v, proxy: v.proxyId ? (map.get(v.proxyId) ?? null) : null }))
}

async function withProxy(db: Database, view: SessionView): Promise<SessionWithProxy> {
  return (await withProxies(db, [view]))[0]!
}
export const pairingCodeSchema = z.object({ phone: phone.optional() })

const uuid = z.uuid()

function sessionId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!uuid.safeParse(id).success) throw new ApiError('SESSION_NOT_FOUND', `session ${id} not found`)
  return id
}

export function toApiError(err: unknown): unknown {
  if (err instanceof InvalidTransitionError) return new ApiError('INVALID_TRANSITION', err.message, { from: err.from, to: err.to })
  if (err instanceof SessionError || err instanceof ProxyError) {
    switch (err.code) {
      case 'SESSION_NOT_FOUND':
        return new ApiError('SESSION_NOT_FOUND', err.message)
      case 'PROXY_IN_USE':
        return new ApiError('PROXY_IN_USE', err.message)
      case 'PROXY_NOT_FOUND':
        return new ApiError('VALIDATION_ERROR', err.message, { issues: [{ path: 'proxyId', message: err.message, code: 'custom' }] })
      case 'VALIDATION_ERROR':
        return new ApiError('VALIDATION_ERROR', err.message, {
          issues: [{ path: (err instanceof SessionError && err.field) || 'phone', message: err.message, code: 'custom' }],
        })
    }
  }
  return err
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

/** Implementação sem worker: leitura/criação no banco; ações de conexão indisponíveis. */
export function dbOnlySessions(store: SessionStore): SessionsControl {
  const unavailable = async (): Promise<never> => {
    throw new ApiError('INTERNAL_ERROR', 'session manager not available')
  }
  return {
    create: async (input) => toSessionView(await store.create(input)),
    list: async () => (await store.list()).map(toSessionView),
    get: async (id) => toSessionView(await store.get(id)),
    startQr: unavailable,
    getQr: unavailable,
    requestPairingCode: unavailable,
    pause: unavailable,
    resume: unavailable,
    restart: unavailable,
    logout: unavailable,
    // Sem o worker não dá para fechar a conexão nem limpar a fila: excluir fica indisponível.
    remove: unavailable,
  }
}

type Action = 'pause' | 'resume' | 'restart' | 'logout'
const ACTIONS: Action[] = ['pause', 'resume', 'restart', 'logout']

export function sessionsRoutes(deps: Pick<AppDeps, 'db' | 'sessions'>) {
  const store = new SessionStore(deps.db)
  const sessions = deps.sessions ?? dbOnlySessions(store)

  const app = new Hono<AppEnv>()
    .get('/api/sessions', async (c) => c.json({ items: await withProxies(deps.db, await run(() => sessions.list())) }))
    .post('/api/sessions', validate('json', createSessionSchema), async (c) => {
      const body = c.req.valid('json')
      const input: CreateSessionInput = { name: body.name, phone: body.phone ?? null }
      if (body.note !== undefined) input.note = body.note
      if (body.proxyId !== undefined) input.proxyId = body.proxyId
      // T17: proxy inline → criado e vinculado na mesma transação da sessão (SessionStore.create).
      if (body.proxy) input.proxy = body.proxy
      const session = await withProxy(deps.db, await run(() => sessions.create(input)))
      setAudit(c, {
        action: 'session.create',
        targetType: 'session',
        targetId: session.id,
        detail: { proxyId: session.proxyId, inlineProxy: !!body.proxy },
      })
      return c.json(session, 201)
    })
    .get('/api/sessions/:id', async (c) => c.json(await withProxy(deps.db, await run(() => sessions.get(sessionId(c))))))
    // T17 (AC-T17-04): edição direto no banco (o worker lê o proxy no connect; troca exige restart).
    .patch('/api/sessions/:id', validate('json', updateSessionSchema), async (c) => {
      const id = sessionId(c)
      const body = c.req.valid('json')
      const res = await run(() =>
        store.updateDetails(id, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(body.proxy !== undefined ? { proxy: body.proxy } : {}),
        }),
      )
      const view = await withProxy(deps.db, toSessionView(res.row))
      setAudit(c, {
        action: 'session.update',
        targetType: 'session',
        targetId: id,
        detail: {
          fields: Object.keys(body).filter((k) => k !== 'proxyId'),
          proxyChanged: res.proxyChanged,
          previousProxyId: res.previousProxyId,
          proxyId: view.proxyId,
          deletedProxyId: res.deletedProxyId,
          requiresRestart: view.requiresRestart,
        },
      })
      return c.json(view)
    })
    .post('/api/sessions/:id/qr', async (c) => {
      const id = sessionId(c)
      const session = await withProxy(deps.db, await run(() => sessions.startQr(id)))
      setAudit(c, { action: 'session.connect', targetType: 'session', targetId: id, detail: { method: 'qr' } })
      return c.json(session, 202)
    })
    .delete('/api/sessions/:id', async (c) => {
      const id = sessionId(c)
      const before = await run(() => sessions.get(id))
      const res = await run(() => sessions.remove(id))
      setAudit(c, {
        action: 'session.delete',
        targetType: 'session',
        targetId: id,
        detail: { name: before.name, status: before.status, deletedProxyId: res.deletedProxyId },
      })
      return c.body(null, 204)
    })
    .get('/api/sessions/:id/qr', async (c) => c.json(await run(() => sessions.getQr(sessionId(c)))))
    .post('/api/sessions/:id/pairing-code', async (c) => {
      const id = sessionId(c)
      const raw = await c.req.text()
      const body = pairingCodeSchema.parse(raw.trim() ? JSON.parse(raw) : {})
      const result = await run(() => sessions.requestPairingCode(id, body.phone))
      setAudit(c, { action: 'session.connect', targetType: 'session', targetId: id, detail: { method: 'pairing_code' } })
      return c.json(result)
    })

  for (const action of ACTIONS) {
    app.post(`/api/sessions/:id/${action}`, async (c) => {
      const id = sessionId(c)
      const session = await withProxy(deps.db, await run(() => sessions[action](id)))
      setAudit(c, { action: `session.${action}`, targetType: 'session', targetId: id, detail: { state: session.status } })
      return c.json(session)
    })
  }
  return app
}
