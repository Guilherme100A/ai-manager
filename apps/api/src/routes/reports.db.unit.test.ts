// GET /api/reports/daily com Postgres local (banco descartável).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DailyReport } from '@wsm/core'
import { createDb, createTempDatabase, sessions, type Database, type TempDatabase } from '@wsm/db'
import { createApp } from '../app'
import { captureLogger, fakeRedis } from '../test-utils'

const TOKEN = 'report-token'
let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_api_reports' })
  db = createDb(tmp.url, { max: 2 })
  await db.insert(sessions).values({ name: 'chip A', phone: '+5531999990000', status: 'WARMING', warmupStartedAt: new Date() })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

const get = (path: string, token: string | null = TOKEN) =>
  createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN })
    .request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })

describe('/api/reports/daily', () => {
  it('devolve os dias pedidos e o estado atual de cada chip', async () => {
    const res = await get('/api/reports/daily?days=3')
    expect(res.status).toBe(200)
    const body = (await res.json()) as DailyReport
    expect(body.days).toHaveLength(3)
    expect(body.chips).toEqual([expect.objectContaining({ name: 'chip A', status: 'WARMING', proxy: false, score: 100 })])
    expect(body.rows).toEqual([])
  })

  it.each(['0', '32', 'abc', '2.5'])('days=%s é rejeitado', async (days) => {
    expect((await get(`/api/reports/daily?days=${days}`)).status).toBe(400)
  })

  it('exige autenticação', async () => {
    expect((await get('/api/reports/daily', null)).status).toBe(401)
  })
})
