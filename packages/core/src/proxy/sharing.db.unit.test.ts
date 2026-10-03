// Limite de chips por IP, contra o Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, proxies, proxySettings, sessions, type Database, type TempDatabase } from '@wsm/db'
import { generateCredentialsKey, resetCredentialsCrypto } from '../crypto'
import { SessionStore } from '../session/store'
import { ProxyService } from './service'
import { DEFAULT_PROXY_SHARING, getProxySharing, saveProxySharing, sessionsOnIp } from './sharing'

let tmp: TempDatabase
let db: Database
let store: SessionStore
const prevKey = process.env.CREDENTIALS_KEY
const ip = (host = '10.0.0.1', port = 8080) => ({ protocol: 'http' as const, host, port })

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_proxy_sharing' })
  db = createDb(tmp.url, { max: 6 })
  store = new SessionStore(db)
})
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})
beforeEach(async () => {
  await db.delete(sessions)
  await db.delete(proxies)
  await db.delete(proxySettings)
})

describe('limite de chips por IP', () => {
  it('padrão: desligado (3), e salva/lê a configuração', async () => {
    expect(await getProxySharing(db)).toEqual(DEFAULT_PROXY_SHARING)
    expect(await saveProxySharing(db, { enabled: true, maxSessionsPerIp: 3 })).toEqual({ enabled: true, maxSessionsPerIp: 3 })
    expect(await getProxySharing(db)).toEqual({ enabled: true, maxSessionsPerIp: 3 })
    await expect(saveProxySharing(db, { enabled: true, maxSessionsPerIp: 0 })).rejects.toThrow()
  })

  it('desligado: o mesmo IP pode ir em quantos chips quiser', async () => {
    for (let i = 0; i < 5; i++) await store.create({ name: `c${i}`, proxy: ip() })
    expect(await sessionsOnIp(db, '10.0.0.1', 8080)).toBe(5)
  })

  it('ligado com 3: o 4º chip no mesmo IP é recusado; outro IP, outra porta ou host em maiúsculas contam certo', async () => {
    await saveProxySharing(db, { enabled: true, maxSessionsPerIp: 3 })
    for (let i = 0; i < 3; i++) await store.create({ name: `c${i}`, proxy: ip() })
    await expect(store.create({ name: 'c3', proxy: ip('10.0.0.1') })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'proxy' })
    await expect(store.create({ name: 'c3', proxy: { ...ip(), host: '10.0.0.1'.toUpperCase() } })).rejects.toThrow('limite é 3')
    await store.create({ name: 'outro-ip', proxy: ip('10.0.0.2') })
    await store.create({ name: 'outra-porta', proxy: ip('10.0.0.1', 9090) })
    expect(await db.select().from(sessions)).toHaveLength(5) // a recusa não deixou sessão nem proxy pela metade
    expect(await db.select().from(proxies)).toHaveLength(5)
  })

  it('trocar o proxy para um IP cheio é recusado; mudar só usuário/senha do mesmo IP é permitido', async () => {
    await saveProxySharing(db, { enabled: true, maxSessionsPerIp: 2 })
    const a = await store.create({ name: 'a', proxy: ip() })
    await store.create({ name: 'b', proxy: ip() })
    const c = await store.create({ name: 'c', proxy: ip('10.0.0.2') })
    await expect(store.updateDetails(c.id, { proxy: ip() })).rejects.toThrow('limite é 2')
    await expect(store.updateDetails(a.id, { proxy: { ...ip(), username: 'u', password: 'p' } })).resolves.toMatchObject({ proxyChanged: true })
  })

  it('vincular um proxy existente (rota de proxies) também respeita o limite', async () => {
    await saveProxySharing(db, { enabled: true, maxSessionsPerIp: 1 })
    await store.create({ name: 'a', proxy: ip() })
    const b = await store.create({ name: 'b' })
    const service = new ProxyService(db)
    const extra = await service.create({ url: 'http://10.0.0.1:8080' })
    await expect(service.assign(extra.id, b.id)).rejects.toMatchObject({ code: 'PROXY_IN_USE' })
    await saveProxySharing(db, { enabled: false, maxSessionsPerIp: 1 })
    await expect(service.assign(extra.id, b.id)).resolves.toMatchObject({ changed: true })
  })

  it('cadastros simultâneos no mesmo IP não passam do limite', async () => {
    await saveProxySharing(db, { enabled: true, maxSessionsPerIp: 3 })
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.create({ name: `p${i}`, proxy: ip() })))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
    expect(await sessionsOnIp(db, '10.0.0.1', 8080)).toBe(3)
  })
})
