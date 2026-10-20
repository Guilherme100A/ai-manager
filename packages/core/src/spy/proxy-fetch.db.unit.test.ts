// Proxy do Espião a partir de um chip (Postgres local): sessão inexistente ou sem proxy dá erro claro.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, sessions, type Database, type TempDatabase } from '@wsm/db'
import { proxyFetch, sessionProxyFetch } from './proxy-fetch'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_spy_proxy' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

describe('sessionProxyFetch', () => {
  it('sessão inexistente ou sem proxy: erro que diz qual sessão', async () => {
    await db.insert(sessions).values({ name: 'Chip sem proxy', phone: '+5531900000009' })
    await expect(sessionProxyFetch(db, 'nao-existe')('https://www.facebook.com/')).rejects.toThrow(/"nao-existe" não existe/)
    await expect(sessionProxyFetch(db, 'Chip sem proxy')('https://www.facebook.com/')).rejects.toThrow(/não tem proxy/)
  })

  it('proxyFetch recusa protocolo de proxy desconhecido e URL que não é https', async () => {
    expect(() => proxyFetch('ftp://x:1')).toThrow()
    await expect(proxyFetch('http://127.0.0.1:9')('http://www.facebook.com/')).rejects.toThrow(/só aceita https/)
  })
})
