// Integração com o Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, healthEvents, proxies, sessionCredentials, sessions, type Database, type TempDatabase } from '@wsm/db'
import { generateCredentialsKey, resetCredentialsCrypto } from '../crypto'
import { ProxyService } from '../proxy'
import { InvalidTransitionError } from './states'
import { SessionError, SessionStore, toSessionView } from './store'

let tmp: TempDatabase
let db: Database
let store: SessionStore
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_session' })
  db = createDb(tmp.url, { max: 4 })
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
})

describe('SessionStore', () => {
  it('cria em NEW e a view não tem campos de credencial', async () => {
    const row = await store.create({ name: 'a', phone: '+5511999990001', note: 'n' })
    const view = toSessionView(row)
    expect(view).toMatchObject({ name: 'a', phone: '+5511999990001', status: 'NEW', state: 'NEW', note: 'n', proxyId: null })
    expect(Object.keys(view).sort()).toEqual(
      ['createdAt', 'id', 'lastConnectedAt', 'name', 'note', 'phone', 'proxyId', 'requiresRestart', 'state', 'status', 'updatedAt', 'warmupStartedAt'].sort(),
    )
  })

  it('rejeita telefone fora do E.164', async () => {
    await expect(store.create({ name: 'a', phone: '11999990001' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('proxy: inexistente → PROXY_NOT_FOUND; já vinculado → PROXY_IN_USE', async () => {
    const proxy = await new ProxyService(db).create({ url: 'http://h:1' })
    await expect(store.create({ name: 'a', phone: '+5511999990001', proxyId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({
      code: 'PROXY_NOT_FOUND',
    })
    const s = await store.create({ name: 'a', phone: '+5511999990001', proxyId: proxy.id })
    expect(s.proxyId).toBe(proxy.id)
    const err = await store.create({ name: 'b', phone: '+5511999990002', proxyId: proxy.id }).catch((e) => e)
    expect(err).toBeInstanceOf(SessionError)
    expect(err.code).toBe('PROXY_IN_USE')
  })

  it('get: id inexistente ou inválido → SESSION_NOT_FOUND', async () => {
    await expect(store.get('nope')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    await expect(store.get('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('transition valida a SPEC 3.2', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001' })
    await expect(store.transition(s.id, 'PAUSED')).rejects.toBeInstanceOf(InvalidTransitionError)
    const r = await store.transition(s.id, 'WARMING', { set: { warmupStartedAt: new Date() } })
    expect(r).toMatchObject({ from: 'NEW', to: 'WARMING', changed: true })
    expect(r.row.warmupStartedAt).toBeInstanceOf(Date)
    await expect(store.transition(s.id, 'WARMING')).rejects.toBeInstanceOf(InvalidTransitionError)
    expect((await store.transition(s.id, 'WARMING', { allowSame: true })).changed).toBe(false)
  })

  it('listResumable: só sessões com credenciais e estado ≠ DISCONNECTED', async () => {
    const mk = async (status: 'NEW' | 'WARMING' | 'PAUSED' | 'DISCONNECTED', creds: boolean) => {
      const [row] = await db.insert(sessions).values({ name: status, phone: '+5511999990001', status }).returning()
      if (creds) {
        const b = Buffer.from('x')
        await db.insert(sessionCredentials).values({ sessionId: row!.id, keyType: 'creds', keyId: 'creds', ciphertext: b, iv: b, authTag: b, keyVersion: 1 })
      }
      return row!.id
    }
    const warming = await mk('WARMING', true)
    const paused = await mk('PAUSED', true)
    await mk('DISCONNECTED', true)
    await mk('WARMING', false)
    const ids = (await store.listResumable()).map((r) => r.id).sort()
    expect(ids).toEqual([warming, paused].sort())
    expect(await store.hasCredentials(warming)).toBe(true)
  })

  it('recordHealthEvent', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001' })
    await store.recordHealthEvent(s.id, 'connected', { state: 'WARMING' })
    const rows = await db.select().from(healthEvents)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: s.id, type: 'connected', detail: { state: 'WARMING' } })
  })

  it('cria sem número (QR): phone null; vazio vira null; update grava o número da conta', async () => {
    const row = await store.create({ name: 'qr', phone: null })
    expect(toSessionView(row).phone).toBeNull()
    expect((await store.create({ name: 'qr2', phone: '  ' })).phone).toBeNull()
    expect((await store.create({ name: 'qr3' })).phone).toBeNull()
    expect((await store.update(row.id, { phone: '+5511999990009' })).phone).toBe('+5511999990009')
  })

  it('delete: apaga sessão, credenciais e eventos em cascata e o proxy que ficou sem uso; outras sessões intactas', async () => {
    const s = await store.create({ name: 'a', phone: '+5511999990001', proxy: { protocol: 'http', host: 'proxy.local', port: 8080 } })
    const other = await store.create({ name: 'b', phone: '+5511999990002' })
    const b = Buffer.from('x')
    await db.insert(sessionCredentials).values({ sessionId: s.id, keyType: 'creds', keyId: 'creds', ciphertext: b, iv: b, authTag: b, keyVersion: 1 })
    await store.recordHealthEvent(s.id, 'connected')
    await store.recordHealthEvent(other.id, 'connected')

    expect(await store.delete(s.id)).toEqual({ deletedProxyId: s.proxyId })
    await expect(store.get(s.id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect(await db.select().from(sessionCredentials)).toHaveLength(0)
    expect((await db.select().from(healthEvents)).map((e) => e.sessionId)).toEqual([other.id])
    expect(await db.select().from(proxies)).toHaveLength(0)
    expect((await store.get(other.id)).id).toBe(other.id)

    expect(await store.delete(other.id)).toEqual({ deletedProxyId: null })
    await expect(store.delete(other.id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    await expect(store.delete('nao-e-uuid')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})
