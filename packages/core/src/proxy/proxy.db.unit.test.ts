// Integração com o Postgres local (banco descartável): serviço, verificador e regra de conexão.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb, createTempDatabase, proxies, sessions, type Database, type TempDatabase } from '@wsm/db'
import { generateCredentialsKey, resetCredentialsCrypto } from '../crypto'
import { FakeTransport, browserForSession } from '../transport'
import type { AuthenticationState } from '../transport'
import { createProxyChecker, type ProxyUnavailableEvent } from './checker'
import { connectSession, resolveSessionBrowser, resolveSessionProxy } from './connect'
import { ProxyError, ProxyUnavailableError } from './errors'
import { ProxyService } from './service'

let tmp: TempDatabase
let db: Database
let service: ProxyService
const prevKey = process.env.CREDENTIALS_KEY
const auth = {} as AuthenticationState

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_proxy' })
  db = createDb(tmp.url, { max: 4 })
  service = new ProxyService(db)
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

async function newSession(name = 's') {
  const [s] = await db.insert(sessions).values({ name, phone: '+5511999990000' }).returning()
  return s!
}

describe('ProxyService', () => {
  it('cria com senha cifrada e devolve URL mascarada', async () => {
    const p = await service.create({ url: 'http://user:SENHA-MARCADOR@10.1.1.1:3128', name: 'p1' })
    expect(p).toMatchObject({ url: 'http://user:***@10.1.1.1:3128', protocol: 'http', port: 3128, sessionId: null, available: true })
    expect(JSON.stringify(p)).not.toContain('SENHA-MARCADOR')
    const raw = await db.$client.query('select * from proxies')
    expect(JSON.stringify(raw.rows)).not.toContain('SENHA-MARCADOR')
    expect(raw.rows[0].password_ciphertext).toBeInstanceOf(Buffer)
    expect(await resolveSessionProxy(db, (await newSession()).id)).toEqual({})
  })

  it('list, get, update e delete', async () => {
    const p = await service.create({ url: 'socks5://h:1080' })
    expect((await service.list()).map((x) => x.id)).toEqual([p.id])
    const u = await service.update(p.id, { url: 'http://a:b@h2:8080', name: 'n' })
    expect(u).toMatchObject({ url: 'http://a:***@h2:8080', name: 'n', protocol: 'http' })
    expect(u.lastChangedAt).toBeInstanceOf(Date)
    await service.delete(p.id)
    await expect(service.get(p.id)).rejects.toMatchObject({ code: 'PROXY_NOT_FOUND' })
  })

  it('proxy já vinculado a outra sessão → PROXY_IN_USE; mesma sessão é idempotente', async () => {
    const p = await service.create({ url: 'http://h:1' })
    const s1 = await newSession('s1')
    const s2 = await newSession('s2')
    expect((await service.assign(p.id, s1.id)).changed).toBe(true)
    expect((await service.assign(p.id, s1.id)).changed).toBe(false)
    await expect(service.assign(p.id, s2.id)).rejects.toMatchObject({ code: 'PROXY_IN_USE' })
    await expect(service.delete(p.id)).rejects.toMatchObject({ code: 'PROXY_IN_USE' })
  })

  it('vínculos concorrentes: só um vence', async () => {
    const p = await service.create({ url: 'http://h:1' })
    const [s1, s2] = [await newSession('a'), await newSession('b')]
    const results = await Promise.allSettled([service.assign(p.id, s1.id), service.assign(p.id, s2.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'PROXY_IN_USE' })
  })

  it('troca de proxy marca requires_restart e last_changed_at sem mudar status', async () => {
    const [a, b] = [await service.create({ url: 'http://a:1' }), await service.create({ url: 'http://b:2' })]
    const s = await newSession()
    await db.update(sessions).set({ status: 'STABLE' }).where(eq(sessions.id, s.id))
    await service.assign(a.id, s.id)
    await db.update(sessions).set({ requiresRestart: false }).where(eq(sessions.id, s.id))
    const r = await service.assign(b.id, s.id)
    expect(r).toMatchObject({ previousProxyId: a.id, changed: true })
    expect(r.proxy.lastChangedAt).toBeInstanceOf(Date)
    const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id))
    expect(row).toMatchObject({ proxyId: b.id, requiresRestart: true, status: 'STABLE' })
    expect((await service.get(a.id)).sessionId).toBeNull()
  })

  it('sessão inexistente → SESSION_NOT_FOUND; unassign desvincula', async () => {
    const p = await service.create({ url: 'http://h:1' })
    await expect(service.assign(p.id, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    const s = await newSession()
    await service.assign(p.id, s.id)
    expect(await service.unassign(p.id)).toMatchObject({ sessionId: s.id, proxy: { sessionId: null } })
    expect(await resolveSessionProxy(db, s.id)).toEqual({})
  })
})

describe('ProxyChecker', () => {
  it('registra sucesso/falha, conta falhas consecutivas e emite proxy_unavailable', async () => {
    const p = await service.create({ url: 'http://h:1' })
    let ok = false
    const events: ProxyUnavailableEvent[] = []
    const checker = createProxyChecker({ db, probe: async () => (ok ? undefined : Promise.reject(new Error('ECONNREFUSED'))) })
    checker.on('proxy_unavailable', (e) => events.push(e))

    await checker.checkAll()
    await checker.checkAll()
    let row = await service.get(p.id)
    expect(row).toMatchObject({ available: false, lastError: 'ECONNREFUSED', errorCount: 2 })
    expect(row.lastCheckAt).toBeInstanceOf(Date)
    expect(events.map((e) => [e.proxyId, e.error, e.errorCount])).toEqual([
      [p.id, 'ECONNREFUSED', 1],
      [p.id, 'ECONNREFUSED', 2],
    ])

    ok = true
    await checker.checkAll()
    row = await service.get(p.id)
    expect(row).toMatchObject({ available: true, lastError: null, errorCount: 0 })
    expect(events).toHaveLength(2)
  })

  it('probe TCP padrão marca porta fechada como indisponível', async () => {
    const p = await service.create({ url: 'http://127.0.0.1:1' })
    const checker = createProxyChecker({ db, timeoutMs: 1000 })
    const [r] = await checker.checkAll()
    expect(r).toMatchObject({ proxyId: p.id, available: false })
  })
})

describe('connectSession (AC-T06-05)', () => {
  it('conecta com a URL do proxy em claro', async () => {
    const p = await service.create({ url: 'socks5://u:pw@h:1080' })
    const s = await newSession()
    await service.assign(p.id, s.id)
    const t = new FakeTransport()
    await connectSession({ db, sessionId: s.id, transport: t, auth })
    expect(t.lastConnect?.proxyUrl).toBe('socks5://u:pw@h:1080')
  })

  it('proxy indisponível: não conecta, fica DISCONNECTED e rejeita', async () => {
    const p = await service.create({ url: 'http://h:1' })
    const s = await newSession()
    await service.assign(p.id, s.id)
    await db.update(sessions).set({ status: 'STABLE' }).where(eq(sessions.id, s.id))
    await db.update(proxies).set({ available: false, lastError: 'down' }).where(eq(proxies.id, p.id))
    const t = new FakeTransport()
    await expect(connectSession({ db, sessionId: s.id, transport: t, auth })).rejects.toBeInstanceOf(ProxyUnavailableError)
    expect(t.connectCalls).toHaveLength(0)
    const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id))
    expect(row?.status).toBe('DISCONNECTED')
  })

  it('credencial ilegível também falha sem conexão direta', async () => {
    const p = await service.create({ url: 'http://u:pw@h:1' })
    const s = await newSession()
    await service.assign(p.id, s.id)
    await db.update(proxies).set({ passwordAuthTag: Buffer.alloc(16) }).where(eq(proxies.id, p.id))
    const t = new FakeTransport()
    await expect(connectSession({ db, sessionId: s.id, transport: t, auth })).rejects.toMatchObject({ code: 'PROXY_UNAVAILABLE' })
    expect(t.connectCalls).toHaveLength(0)
  })

  it('após troca, a próxima conexão usa o proxy novo', async () => {
    const [a, b] = [await service.create({ url: 'http://a:1' }), await service.create({ url: 'http://b:2' })]
    const s = await newSession()
    await service.assign(a.id, s.id)
    const t = new FakeTransport()
    await connectSession({ db, sessionId: s.id, transport: t, auth })
    await service.assign(b.id, s.id)
    await connectSession({ db, sessionId: s.id, transport: t, auth })
    expect(t.connectCalls.map((c) => c.proxyUrl)).toEqual(['http://a:1', 'http://b:2'])
  })

  it('sessão inexistente → SESSION_NOT_FOUND', async () => {
    await expect(resolveSessionProxy(db, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(ProxyError)
  })
})

describe('fingerprint fixo por sessão', () => {
  it('1ª conexão grava o aparelho derivado do id e as reconexões repetem o mesmo', async () => {
    const s = await newSession()
    const t = new FakeTransport()
    await connectSession({ db, sessionId: s.id, transport: t, auth })
    await connectSession({ db, sessionId: s.id, transport: t, auth })
    await connectSession({ db, sessionId: s.id, transport: t, auth })
    const expected = browserForSession(s.id)
    expect(t.connectCalls.map((c) => c.browser)).toEqual([expected, expected, expected])
    const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id))
    expect(row?.browser).toEqual(expected)
  })

  it('aparelho já gravado nunca é substituído', async () => {
    const s = await newSession()
    const stored: [string, string, string] = ['Mac OS', 'Safari', '17.0']
    await db.update(sessions).set({ browser: stored }).where(eq(sessions.id, s.id))
    const t = new FakeTransport()
    await connectSession({ db, sessionId: s.id, transport: t, auth })
    expect(t.lastConnect?.browser).toEqual(stored)
    expect(await resolveSessionBrowser(db, s.id)).toEqual(stored)
  })

  it('com proxy também envia o aparelho fixo', async () => {
    const p = await service.create({ url: 'http://h:3128' })
    const s = await newSession()
    await service.assign(p.id, s.id)
    const t = new FakeTransport()
    await connectSession({ db, sessionId: s.id, transport: t, auth })
    expect(t.lastConnect).toMatchObject({ proxyUrl: 'http://h:3128', browser: browserForSession(s.id) })
  })
})
