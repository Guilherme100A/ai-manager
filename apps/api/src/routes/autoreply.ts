// Números de autoresposta (próprios do operador) para as conversas dos chips com proxy: listar, adicionar e remover.
import { Hono } from 'hono'
import { z } from 'zod'
import { AutoReplyTargets } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

const addSchema = z.object({ phones: z.array(z.string().max(40)).min(1).max(500) })
const idParam = z.object({ id: z.uuid() })

export function autoReplyRoutes(deps: Pick<AppDeps, 'db'>) {
  const targets = new AutoReplyTargets(deps.db)
  return new Hono<AppEnv>()
    .get('/api/autoreply-targets', async (c) => c.json({ items: await targets.list() }))
    .post('/api/autoreply-targets', validate('json', addSchema), async (c) => {
      const result = await targets.add(c.req.valid('json').phones)
      setAudit(c, { action: 'autoreply.add', targetType: 'contact', detail: { added: result.added.length, invalid: result.invalid.length } })
      return c.json(result, 201)
    })
    .delete('/api/autoreply-targets/:id', validate('param', idParam), async (c) => {
      const { id } = c.req.valid('param')
      if (!await targets.remove(id)) throw new ApiError('NOT_FOUND', 'Número não encontrado na lista.')
      setAudit(c, { action: 'autoreply.remove', targetType: 'contact', targetId: id })
      return c.body(null, 204)
    })
}
