// GET /api/reports/daily?days=7: números por chip e por dia (Brasília) para decidir ajustes. Só leitura.
// GET /api/reports/message-counts: enviadas/recebidas por chip (total e últimas 24 h).
import { Hono } from 'hono'
import { buildDailyReport, MAX_REPORT_DAYS, messageCountsBySession } from '@wsm/core'
import { ApiError } from '../errors'
import type { AppDeps, AppEnv } from '../types'

export function reportsRoutes(deps: Pick<AppDeps, 'db' | 'healthOptions'>) {
  return new Hono<AppEnv>().get('/api/reports/daily', async (c) => {
    const raw = c.req.query('days')
    const days = raw === undefined ? 7 : Number(raw)
    if (!Number.isInteger(days) || days < 1 || days > MAX_REPORT_DAYS) {
      throw new ApiError('VALIDATION_ERROR', `days must be an integer between 1 and ${MAX_REPORT_DAYS}`)
    }
    return c.json(await buildDailyReport(deps.db, { days, ...(deps.healthOptions ? { health: deps.healthOptions } : {}) }))
  })
    .get('/api/reports/message-counts', async (c) => c.json({ items: await messageCountsBySession(deps.db) }))
}
