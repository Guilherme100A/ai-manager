// Espião de funil: links de anúncios entram na fila; o SpyRunner (server.ts) acha o WhatsApp de cada oferta.
import { Hono } from 'hono'
import { z } from 'zod'
import { SpyStore, normalizePhone } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

export const spyLinksSchema = z.object({
  links: z.array(z.string().trim().min(1).max(2048)).min(1).max(50),
}).strict()

const adParam = z.object({ id: z.uuid() })
const manualPhoneSchema = z.object({ phone: z.string().trim().min(8).max(40) }).strict()

export function spyRoutes(deps: Pick<AppDeps, 'db'>) {
  const store = new SpyStore(deps.db)
  return new Hono<AppEnv>()
    .get('/api/spy/ads', async (c) => c.json({ items: await store.listAds() }))
    .get('/api/spy/offers', async (c) => c.json({ items: await store.listOffers() }))
    .post('/api/spy/ads', validate('json', spyLinksSchema), async (c) => {
      const links = [...new Set(c.req.valid('json').links)]
      const result = await store.enqueue(links, c.get('actor'))
      setAudit(c, { action: 'spy.enqueue', targetType: 'spy_ad', detail: { created: result.created.length, skipped: result.skipped.length } })
      return c.json(result, 201)
    })
    .post('/api/spy/ads/:id/retry', validate('param', adParam), async (c) => {
      const row = await store.retry(c.req.valid('param').id)
      if (!row) throw new ApiError('NOT_FOUND', 'Anúncio não encontrado ou ainda em andamento')
      return c.json(row)
    })
    .put('/api/spy/ads/:id/phone', validate('param', adParam), validate('json', manualPhoneSchema), async (c) => {
      const phone = normalizePhone(c.req.valid('json').phone)
      if (!phone) throw new ApiError('VALIDATION_ERROR', 'Número inválido: use o DDI, ex.: 5584920022034')
      const row = await store.found(c.req.valid('param').id, { phone, foundVia: 'manual' })
      if (!row) throw new ApiError('NOT_FOUND', 'Anúncio não encontrado')
      setAudit(c, { action: 'spy.manual_phone', targetType: 'spy_ad', targetId: row.id })
      return c.json(row)
    })
    .delete('/api/spy/ads/:id', validate('param', adParam), async (c) => {
      const { id } = c.req.valid('param')
      if (!(await store.remove(id))) throw new ApiError('NOT_FOUND', 'Anúncio não encontrado')
      setAudit(c, { action: 'spy.delete', targetType: 'spy_ad', targetId: id })
      return c.body(null, 204)
    })
}
