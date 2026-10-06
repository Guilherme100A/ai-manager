// SessionManager com Postgres local (banco descartável) e FakeTransport.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  generateCredentialsKey,
  InvalidTransitionError,
  ProxyService,
  resetCredentialsCrypto,
  usePostgresAuthState,
} from '@wsm/core'
import {
  createDb,
  createTempDatabase,
  healthEvents,
  proxies,
  sessionCredentials,
  sessions,
  type Database,
  type TempDatabase,
} from '@wsm/db'
import { SessionManager, type SessionManagerOptions } from './manager'
import { createFakeTransportFactory, type FakeTransportFactory } from './transport-factory'

let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_worker_sessions' })
  db = createDb(tmp.url, { max: 6 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

let fakes: FakeTransportFactory
let manager: SessionManager
let delays: number[]
let connected: string[]
const managers: SessionManager[] = []

function newManager(extra: Partial<SessionManagerOptions> = {}) {
  const m = new SessionManager({
    db,
    transportFactory: fakes.factory,
    sleep: async (ms) => void delays.push(ms),
    onConnected: (id) => void connected.push(id),
    pairingTimeoutMs: 2_000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...extra,
  })
  managers.push(m)
  return m
}

beforeEach(async () => {
  await db.delete(sessions)
  await db.delete(proxies)
  fakes = createFakeTransportFactory()
  delays = []
  connected = []
  manager = newManager()
})

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()))
})

const status = async (id: string) => (await db.select().from(sessions).where(eq(sessions.id, id)))[0]!.status
const events = async (id: string) => (await db.select().from(healthEvents).where(eq(healthEvents.sessionId, id))).map((e) => e.type)
const credsCount = async (id: string) => (await db.select().from(sessionCredentials).where(eq(sessionCredentials.sessionId, id))).length

async function until(fn: () => boolean) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(fn()).toBe(true)
}

async function connectedSession(m = manager) {
  const s = await m.create({ name: 's', phone: '+5511999990001' })
  await m.startQr(s.id)
  fakes.last(s.id)!.open()
  await m.whenIdle()
  return s.id
}

describe('autenticação (AC-T05-02/03)', () => {
  it('POST qr conecta via connectSession com saveCreds; QR vira data URL', async () => {
    const s = await manager.create({ name: 's', phone: '+5511999990001' })
    expect(s.status).toBe('NEW')
    expect(await manager.getQr(s.id)).toEqual({ qr: null, generatedAt: null })
    await manager.startQr(s.id)
    const t = fakes.last(s.id)!
    expect(t.connectCalls).toHaveLength(1)
    expect(t.lastConnect).toMatchObject({ sessionId: s.id })
    expect(typeof t.lastConnect!.saveCreds).toBe('function')
    expect(t.lastConnect!.proxyUrl).toBeUndefined()
    t.emitQr('2@abc,def')
    const qr = await manager.getQr(s.id)
    expect(qr.qr).toMatch(/^data:image\/png;base64,/)
    // idempotente enquanto aguarda o QR
    await manager.startQr(s.id)
    expect(fakes.created.get(s.id)).toHaveLength(1)
  })

  it('ao abrir: WARMING, creds cifradas, health_event connected, monitoramento iniciado', async () => {
    const id = await connectedSession()
    expect(await status(id)).toBe('WARMING')
    expect(await credsCount(id)).toBeGreaterThan(0)
    const raw = await db.$client.query('select ciphertext from session_credentials where session_id = $1', [id])
    expect(String(raw.rows[0].ciphertext)).not.toContain('noiseKey')
    expect(await events(id)).toEqual(['connected'])
    expect(connected).toEqual([id])
    expect(manager.isMonitoring(id)).toBe(true)
    const view = await manager.get(id)
    expect(view.warmupStartedAt).not.toBeNull()
    expect(view.lastConnectedAt).not.toBeNull()
    // sessão já autenticada não inicia QR
    await expect(manager.startQr(id)).rejects.toBeInstanceOf(InvalidTransitionError)
  })

  it('pairing code: conecta com pairingPhone e devolve o código emitido', async () => {
    const s = await manager.create({ name: 's', phone: '+5511999990001' })
    const pending = manager.requestPairingCode(s.id)
    await until(() => (fakes.last(s.id)?.connectCalls.length ?? 0) > 0)
    const t = fakes.last(s.id)!
    expect(t.lastConnect!.pairingPhone).toBe('+5511999990001')
    t.emitPairingCode('ABCD-1234')
    await expect(pending).resolves.toEqual({ code: 'ABCD-1234' })
    await expect(manager.requestPairingCode(s.id)).resolves.toEqual({ code: 'ABCD-1234' })
  })

  it('pairing code: timeout rejeita', async () => {
    const m = newManager({ pairingTimeoutMs: 20 })
    const s = await m.create({ name: 's', phone: '+5511999990001' })
    await expect(m.requestPairingCode(s.id)).rejects.toMatchObject({ code: 'PAIRING_TIMEOUT' })
  })
})

describe('restart do worker (AC-T05-04)', () => {
  it('reconecta sessões com credenciais; PAUSED continua PAUSED; DISCONNECTED não', async () => {
    const a = await connectedSession()
    const b = await connectedSession()
    await manager.pause(b)
    const c = await connectedSession()
    await db.update(sessions).set({ status: 'DISCONNECTED' }).where(eq(sessions.id, c))
    const d = (await manager.create({ name: 'sem creds', phone: '+5511999990009' })).id
    await manager.stop()
    expect(await status(a)).toBe('WARMING')

    const m2 = newManager()
    await m2.start()
    expect(fakes.created.get(a)).toHaveLength(2)
    expect(fakes.created.get(b)).toHaveLength(2)
    expect(fakes.created.get(c)).toHaveLength(1)
    expect(fakes.created.get(d)).toBeUndefined()
    fakes.last(a)!.open()
    fakes.last(b)!.open()
    await m2.whenIdle()
    expect(await status(a)).toBe('WARMING')
    expect(await status(b)).toBe('PAUSED')
  })
})

describe('quedas (AC-T05-05)', () => {
  it('loggedOut → DISCONNECTED, credenciais apagadas, sem reconexão', async () => {
    const id = await connectedSession()
    await fakes.last(id)!.close('loggedOut', 401)
    await manager.whenIdle()
    expect(await status(id)).toBe('DISCONNECTED')
    expect(await credsCount(id)).toBe(0)
    expect(fakes.last(id)!.connectCalls).toHaveLength(1)
    expect(delays).toEqual([])
    expect(manager.isMonitoring(id)).toBe(false)
  })

  it('forbidden → PAUSED + forbidden_403, sem reconexão', async () => {
    const id = await connectedSession()
    await fakes.last(id)!.close('forbidden', 403)
    await manager.whenIdle()
    expect(await status(id)).toBe('PAUSED')
    expect(await events(id)).toContain('forbidden_403')
    expect(fakes.last(id)!.connectCalls).toHaveLength(1)
    expect(fakes.created.get(id)).toHaveLength(1)
  })

  it('transient → backoff exponencial, 5 tentativas, depois DISCONNECTED', async () => {
    const id = await connectedSession()
    const t = fakes.last(id)!
    for (let i = 0; i < 6; i++) {
      await t.close('transient', 428)
      await manager.whenIdle()
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(t.connectCalls).toHaveLength(6)
    expect(await status(id)).toBe('DISCONNECTED')
    const ev = await events(id)
    expect(ev.filter((e) => e === 'disconnected')).toHaveLength(6)
    expect(ev).toContain('reconnect_failed')
  })

  it('abrir de novo zera o contador de tentativas', async () => {
    const id = await connectedSession()
    const t = fakes.last(id)!
    await t.close('transient')
    await manager.whenIdle()
    await t.close('transient')
    await manager.whenIdle()
    t.open()
    await manager.whenIdle()
    expect(manager.runtimeInfo(id)?.reconnectAttempts).toBe(0)
    await t.close('transient')
    await manager.whenIdle()
    expect(delays).toEqual([1000, 2000, 1000])
    expect(await status(id)).toBe('WARMING')
    expect(connected).toEqual([id, id])
  })

  it('proxy indisponível: não conecta sem proxy e fica DISCONNECTED', async () => {
    const proxy = await new ProxyService(db).create({ url: 'http://u:p@10.0.0.1:3128' })
    await db.update(proxies).set({ available: false, lastError: 'down' }).where(eq(proxies.id, proxy.id))
    const s = await manager.create({ name: 's', phone: '+5511999990001', proxyId: proxy.id })
    const view = await manager.startQr(s.id)
    expect(view.status).toBe('DISCONNECTED')
    expect(fakes.last(s.id)!.connectCalls).toHaveLength(0)
    expect(await events(s.id)).toContain('proxy_unavailable')
  })

  it('proxy volta: sessão que caiu por ele reconecta sozinha, sem QR e mantendo o aquecimento', async () => {
    const proxy = await new ProxyService(db).create({ url: 'http://u:p@10.0.0.1:3128' })
    const s = await manager.create({ name: 's', phone: '+5511999990001', proxyId: proxy.id })
    await manager.startQr(s.id)
    fakes.last(s.id)!.open()
    await manager.whenIdle()
    const warmup = (await manager.get(s.id)).warmupStartedAt
    expect(warmup).not.toBeNull()

    await db.update(proxies).set({ available: false, lastError: 'timeout' }).where(eq(proxies.id, proxy.id))
    await fakes.last(s.id)!.close('transient', 408)
    await manager.whenIdle()
    expect(await status(s.id)).toBe('DISCONNECTED')
    expect((await events(s.id)).at(-1)).toBe('proxy_unavailable')
    expect(await credsCount(s.id)).toBeGreaterThan(0)

    expect(await manager.recoverAfterProxy(s.id)).toBe(true) // ainda indisponível: tenta e volta a DISCONNECTED
    await manager.whenIdle()
    expect(await status(s.id)).toBe('DISCONNECTED')

    await db.update(proxies).set({ available: true, lastError: null }).where(eq(proxies.id, proxy.id))
    expect(await manager.recoverAfterProxy(s.id)).toBe(true)
    expect(await manager.recoverAfterProxy(s.id)).toBe(false) // já reconectando: não duplica
    const t = fakes.last(s.id)!
    expect(new URL(t.lastConnect!.proxyUrl!).hostname).toBe('10.0.0.1')
    t.open()
    await manager.whenIdle()
    expect(await status(s.id)).toBe('WARMING')
    expect((await manager.get(s.id)).warmupStartedAt).toBe(warmup)
  })

  it('não reconecta sozinha sessão deslogada, sem proxy ou que caiu por outro motivo', async () => {
    const loggedOut = await connectedSession()
    await fakes.last(loggedOut)!.close('loggedOut', 401)
    await manager.whenIdle()
    expect(await status(loggedOut)).toBe('DISCONNECTED')
    expect(await manager.recoverAfterProxy(loggedOut)).toBe(false)

    const proxy = await new ProxyService(db).create({ url: 'http://u:p@10.0.0.2:3128' })
    const s = await manager.create({ name: 'p', phone: '+5511999990002', proxyId: proxy.id })
    await manager.startQr(s.id)
    fakes.last(s.id)!.open()
    await manager.whenIdle()
    await fakes.last(s.id)!.close('loggedOut', 401)
    await manager.whenIdle()
    expect(await manager.recoverAfterProxy(s.id)).toBe(false) // último evento não é proxy_unavailable
    expect(await manager.recoverAfterProxy(loggedOut)).toBe(false)
  })

  it('com proxy disponível conecta pelo proxy', async () => {
    const proxy = await new ProxyService(db).create({ url: 'http://u:p@10.0.0.1:3128' })
    const s = await manager.create({ name: 's', phone: '+5511999990001', proxyId: proxy.id })
    await manager.startQr(s.id)
    expect(new URL(fakes.last(s.id)!.lastConnect!.proxyUrl!).hostname).toBe('10.0.0.1')
  })
})

describe('vigia de conexão', () => {
  // O FakeTransport nunca marca a conta como pareada; aqui simulamos uma conta já registrada.
  const registered: SessionManagerOptions['authStateFactory'] = async (d, id) => {
    const auth = await usePostgresAuthState(d, id)
    auth.state.creds.registered = true
    return auth
  }

  it('conta pareada que não abre no prazo: vira queda transitória, tenta de novo e conecta', async () => {
    const m = newManager({ connectTimeoutMs: 100, authStateFactory: registered })
    const s = await m.create({ name: 's', phone: '+5511999990001' })
    await m.startQr(s.id)
    const t = fakes.last(s.id)!
    expect(t.connectCalls).toHaveLength(1)
    await until(() => t.connectCalls.length >= 2) // pendurou: o vigia derrubou e o backoff reconectou
    expect(await events(s.id)).toContain('disconnected')
    t.open()
    await m.whenIdle()
    expect(await status(s.id)).toBe('WARMING')
    const calls = t.connectCalls.length
    await new Promise((r) => setTimeout(r, 120))
    expect(t.connectCalls).toHaveLength(calls) // conectado: o vigia não age mais
    expect(await status(s.id)).toBe('WARMING')
  })

  it('não vigia QR/pareamento: conta ainda não pareada espera o tempo que for', async () => {
    const m = newManager({ connectTimeoutMs: 40 })
    const s = await m.create({ name: 's', phone: '+5511999990001' })
    await m.startQr(s.id)
    await new Promise((r) => setTimeout(r, 150))
    expect(fakes.last(s.id)!.connectCalls).toHaveLength(1)
    expect(await events(s.id)).not.toContain('disconnected')
  })

  it('queda real antes do prazo não gera reconexão dobrada pelo vigia', async () => {
    const m = newManager({ connectTimeoutMs: 400, authStateFactory: registered, sleep: (ms) => new Promise((r) => { delays.push(ms); setTimeout(r, 1200) }) })
    const s = await m.create({ name: 's', phone: '+5511999990001' })
    await m.startQr(s.id)
    const t = fakes.last(s.id)!
    await t.close('transient', 428) // cai sozinha; o backoff espera 1,2 s, passando do prazo do vigia (400 ms)
    await until(() => delays.length === 1)
    await new Promise((r) => setTimeout(r, 500)) // o vigia da tentativa anterior dispara aqui e não pode agir
    expect(delays).toHaveLength(1)
    expect(t.connectCalls).toHaveLength(1)
    await until(() => t.connectCalls.length === 2)
    t.open()
    await m.whenIdle()
    expect(delays).toHaveLength(1)
    expect(await status(s.id)).toBe('WARMING')
  })
})

describe('ações manuais (AC-T05-06)', () => {
  it('pause / resume / restart / logout', async () => {
    const id = await connectedSession()
    expect((await manager.pause(id)).status).toBe('PAUSED')
    await expect(manager.pause(id)).rejects.toBeInstanceOf(InvalidTransitionError)
    expect((await manager.resume(id)).status).toBe('WARMING')
    await expect(manager.resume(id)).rejects.toBeInstanceOf(InvalidTransitionError)

    await db.update(sessions).set({ requiresRestart: true }).where(eq(sessions.id, id))
    const r = await manager.restart(id)
    expect(r.status).toBe('WARMING')
    expect(r.requiresRestart).toBe(false)
    expect(fakes.created.get(id)).toHaveLength(2)
    expect(fakes.created.get(id)![0]!.closed).toBe(true)

    fakes.last(id)!.open()
    await manager.whenIdle()
    const out = await manager.logout(id)
    expect(out.status).toBe('DISCONNECTED')
    expect(fakes.last(id)!.loggedOut).toBe(true)
    expect(await credsCount(id)).toBe(0)
    await expect(manager.logout(id)).rejects.toBeInstanceOf(InvalidTransitionError)
    await expect(manager.restart(id)).rejects.toBeInstanceOf(InvalidTransitionError)
    // re-autenticação: DISCONNECTED → NEW
    expect((await manager.startQr(id)).status).toBe('NEW')
  })

  it('cadastro por QR sem número: ao conectar, grava o número da conta; número errado é corrigido', async () => {
    const s = await manager.create({ name: 'qr', phone: null })
    expect(s.phone).toBeNull()
    await manager.startQr(s.id)
    const t = fakes.last(s.id)!
    t.phone = '+5511999990007'
    t.open()
    await manager.whenIdle()
    expect((await manager.get(s.id)).phone).toBe('+5511999990007')

    const typo = await manager.create({ name: 'typo', phone: '+5511999990001' })
    await manager.startQr(typo.id)
    const t2 = fakes.last(typo.id)!
    t2.phone = '+5511999990008'
    t2.open()
    await manager.whenIdle()
    expect((await manager.get(typo.id)).phone).toBe('+5511999990008')
  })

  it('pairing code sem número na sessão nem na requisição → VALIDATION_ERROR, sem abrir conexão', async () => {
    const s = await manager.create({ name: 'qr', phone: null })
    await expect(manager.requestPairingCode(s.id)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', field: 'phone' })
    expect(fakes.created.get(s.id)).toBeUndefined()
  })

  it('remove: desvincula o aparelho, fecha a conexão sem reconectar e apaga do banco; vale também em NEW', async () => {
    const id = await connectedSession()
    const t = fakes.last(id)!
    expect(await manager.remove(id)).toEqual({ deletedProxyId: null })
    expect(t.loggedOut).toBe(true)
    expect(t.closed).toBe(true)
    expect(manager.isConnected(id)).toBe(false)
    await manager.whenIdle()
    expect(await db.select().from(sessions).where(eq(sessions.id, id))).toHaveLength(0)
    expect(await credsCount(id)).toBe(0)
    expect(fakes.created.get(id)).toHaveLength(1)
    await expect(manager.remove(id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })

    const fresh = await manager.create({ name: 'n', phone: '+5511999990002' })
    await manager.remove(fresh.id)
    await expect(manager.get(fresh.id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('pause/resume em NEW são inválidos; id inexistente → SESSION_NOT_FOUND', async () => {
    const s = await manager.create({ name: 's', phone: '+5511999990001' })
    await expect(manager.pause(s.id)).rejects.toBeInstanceOf(InvalidTransitionError)
    await expect(manager.resume(s.id)).rejects.toBeInstanceOf(InvalidTransitionError)
    await expect(manager.pause('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('resume reabre a conexão de sessão pausada por 403', async () => {
    const id = await connectedSession()
    await fakes.last(id)!.close('forbidden', 403)
    await manager.whenIdle()
    expect(manager.getTransport(id)).toBeUndefined()
    await manager.resume(id)
    expect(fakes.created.get(id)).toHaveLength(2)
    expect(manager.getTransport(id)).toBe(fakes.last(id))
  })
})
