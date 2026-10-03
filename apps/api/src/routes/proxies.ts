// /api/proxies (T06): CRUD com senha cifrada/URL mascarada e vínculo 1:1 com sessão.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { getProxySharing, MAX_SESSIONS_PER_IP_LIMIT, ProxyError, ProxyService, ProxyUrlError, parseProxyUrl, saveProxySharing } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

const proxyUrl = z
  .string()
  .trim()
  .min(1)
  .superRefine((v, ctx) => {
    try {
      parseProxyUrl(v)
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: err instanceof ProxyUrlError ? err.message : 'invalid proxy URL' })
    }
  })
const name = z.string().trim().min(1).max(200).nullable().optional()

export const createProxySchema = z.object({ url: proxyUrl, name })
export const updateProxySchema = z
  .object({ url: proxyUrl.optional(), name })
  .refine((b) => b.url !== undefined || b.name !== undefined, { message: 'nothing to update (url or name)' })
export const assignSessionSchema = z.object({ sessionId: z.uuid() })

const uuid = z.uuid()

/** `:id` que não é UUID não pode existir: 404, como um proxy inexistente. */
function proxyId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!uuid.safeParse(id).success) throw new ApiError('NOT_FOUND', `proxy ${id} not found`)
  return id
}

export function toApiError(err: unknown): unknown {
  if (err instanceof ProxyUrlError) return new ApiError('VALIDATION_ERROR', err.message, { issues: [{ path: 'url', message: err.message, code: 'custom' }] })
  if (!(err instanceof ProxyError)) return err
  switch (err.code) {
    case 'PROXY_NOT_FOUND':
      return new ApiError('NOT_FOUND', err.message)
    case 'SESSION_NOT_FOUND':
      return new ApiError('SESSION_NOT_FOUND', err.message)
    case 'PROXY_IN_USE':
      return new ApiError('PROXY_IN_USE', err.message)
    default:
      return err
  }
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

const proxySharingSchema = z.object({ enabled: z.boolean(), maxSessionsPerIp: z.number().int().min(1).max(MAX_SESSIONS_PER_IP_LIMIT) }).strict()

export function proxiesRoutes(deps: Pick<AppDeps, 'db'>) {
  const service = new ProxyService(deps.db)

  return new Hono<AppEnv>()
    // Limite de chips por IP (botão no painel). Vale nos próximos cadastros/trocas de proxy; não desfaz vínculos atuais.
    .get('/api/proxy-sharing', async (c) => c.json(await getProxySharing(deps.db)))
    .put('/api/proxy-sharing', validate('json', proxySharingSchema), async (c) => {
      const settings = await saveProxySharing(deps.db, c.req.valid('json'))
      setAudit(c, { action: 'proxy.sharing.update', targetType: 'settings', targetId: 'proxy-sharing', detail: { ...settings } })
      return c.json(settings)
    })
    .get('/api/proxies', async (c) => c.json({ items: await run(() => service.list()) }))
    .post('/api/proxies', validate('json', createProxySchema), async (c) => {
      const proxy = await run(() => service.create(c.req.valid('json')))
      setAudit(c, { action: 'proxy.create', targetType: 'proxy', targetId: proxy.id })
      return c.json(proxy, 201)
    })
    .get('/api/proxies/:id', async (c) => c.json(await run(() => service.get(proxyId(c)))))
    .patch('/api/proxies/:id', validate('json', updateProxySchema), async (c) => {
      const id = proxyId(c)
      const body = c.req.valid('json')
      const proxy = await run(() => service.update(id, body))
      setAudit(c, {
        action: 'proxy.update',
        targetType: 'proxy',
        targetId: id,
        detail: { fields: Object.keys(body), sessionId: proxy.sessionId },
      })
      return c.json(proxy)
    })
    .delete('/api/proxies/:id', async (c) => {
      const id = proxyId(c)
      await run(() => service.delete(id))
      setAudit(c, { action: 'proxy.delete', targetType: 'proxy', targetId: id })
      return c.body(null, 204)
    })
    .put('/api/proxies/:id/session', validate('json', assignSessionSchema), async (c) => {
      const id = proxyId(c)
      const { sessionId } = c.req.valid('json')
      const result = await run(() => service.assign(id, sessionId))
      setAudit(c, {
        action: 'session.proxy_change',
        targetType: 'session',
        targetId: sessionId,
        detail: { proxyId: id, previousProxyId: result.previousProxyId, changed: result.changed, requiresRestart: result.changed },
      })
      return c.json({ ...result.proxy, requiresRestart: result.changed })
    })
    .delete('/api/proxies/:id/session', async (c) => {
      const id = proxyId(c)
      const result = await run(() => service.unassign(id))
      setAudit(c, {
        action: 'session.proxy_change',
        targetType: result.sessionId ? 'session' : 'proxy',
        targetId: result.sessionId ?? id,
        detail: { proxyId: null, previousProxyId: id, changed: result.sessionId !== null },
      })
      return c.json(result.proxy)
    })
}
