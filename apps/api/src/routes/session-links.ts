import { Hono } from 'hono'
import { z } from 'zod'
import { SessionLinkStore, SessionStore } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

export const createSessionLinkSchema = z.object({
  sourceSessionId: z.uuid(),
  targetSessionId: z.uuid(),
  rules: z.object({
    matchText: z.string().trim().min(1).max(4096),
    replyText: z.string().trim().min(1).max(4096),
  }).strict(),
}).strict().refine((v) => v.sourceSessionId !== v.targetSessionId, { message: 'Escolha duas sessões diferentes', path: ['targetSessionId'] })

const linkParam = z.object({ id: z.uuid() })
const enabledSchema = z.object({ enabled: z.boolean() }).strict()

export function sessionLinksRoutes(deps: Pick<AppDeps, 'db'>) {
  const store = new SessionLinkStore(deps.db)
  const sessions = new SessionStore(deps.db)
  return new Hono<AppEnv>()
    .get('/api/session-links', async (c) => c.json({ items: await store.list() }))
    .get('/api/session-links/runs', async (c) => c.json({ items: await store.runs() }))
    .post('/api/session-links', validate('json', createSessionLinkSchema), async (c) => {
      const input = c.req.valid('json')
      for (const id of [input.sourceSessionId, input.targetSessionId]) {
        if (!(await sessions.find(id))) throw new ApiError('SESSION_NOT_FOUND', 'Sessão não encontrada')
      }
      const link = await store.create({ ...input, enabled: false, createdBy: c.get('actor') })
      setAudit(c, { action: 'session_link.create', targetType: 'session_link', targetId: link.id })
      return c.json(link, 201)
    })
    .patch('/api/session-links/:id', validate('param', linkParam), validate('json', enabledSchema), async (c) => {
      const { enabled } = c.req.valid('json')
      const link = await store.setEnabled(c.req.valid('param').id, enabled)
      if (!link) throw new ApiError('NOT_FOUND', 'Vínculo não encontrado')
      setAudit(c, { action: 'session_link.update', targetType: 'session_link', targetId: link.id, detail: { enabled } })
      return c.json(link)
    })
    .delete('/api/session-links/:id', validate('param', linkParam), async (c) => {
      const { id } = c.req.valid('param')
      if (!(await store.remove(id))) throw new ApiError('NOT_FOUND', 'Vínculo não encontrado')
      setAudit(c, { action: 'session_link.delete', targetType: 'session_link', targetId: id })
      return c.body(null, 204)
    })
}
