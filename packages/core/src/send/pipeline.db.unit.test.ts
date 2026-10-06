// SendPipeline + SessionLimitsService com Postgres local (banco descartável).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { contacts, createDb, createTempDatabase, messages, sessionLimits, sessions, type Database, type TempDatabase } from '@wsm/db'
import { generateCredentialsKey, resetCredentialsCrypto } from '../crypto'
import { MessageStore, type EnqueueMessageInput } from '../queue/store'
import { computeEffectiveLimits, DEFAULT_SEND_LIMITS, SessionLimitsService } from '../safety/limits'
import { FakeTransport } from '../transport'
import { DAY_MS } from '../warmup'
import { GATE_ORDER, SendPipeline, SendRejectedError, type Gate, type GateName } from './pipeline'

let tmp: TempDatabase
let db: Database
const prevKey = process.env.CREDENTIALS_KEY

beforeAll(async () => {
  process.env.CREDENTIALS_KEY = generateCredentialsKey()
  resetCredentialsCrypto()
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_pipeline' })
  db = createDb(tmp.url, { max: 4 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
  process.env.CREDENTIALS_KEY = prevKey
  resetCredentialsCrypto()
})

beforeEach(async () => {
  await db.delete(sessions)
  await db.delete(contacts)
})

const PHONE = '+5511988887777'
let now = new Date('2026-09-24T12:00:00Z')

async function session(status: 'NEW' | 'WARMING' | 'STABLE' | 'DEGRADED' | 'PAUSED' = 'WARMING', warmupAgeMs = 0) {
  const [row] = await db
    .insert(sessions)
    .values({ name: 's', phone: '+5511999990001', status, warmupStartedAt: new Date(now.getTime() - warmupAgeMs) })
    .returning()
  return row!.id
}

async function contact(opts: { consent?: boolean; optOut?: boolean } = {}) {
  await db.insert(contacts).values({ phone: PHONE, consent: opts.consent ?? true, optOut: opts.optOut ?? false })
}

function setup(extra: Partial<ConstructorParameters<typeof SendPipeline>[0]> = {}) {
  const store = new MessageStore(db)
  const queue = { enqueue: vi.fn(async (input: EnqueueMessageInput) => (await store.create(input)) && toView(await store.list({ sessionId: input.sessionId }))) }
  const transports = new Map<string, FakeTransport>()
  const pipeline = new SendPipeline({ db, queue, getTransport: (id) => transports.get(id), now: () => now, ...extra })
  return { pipeline, queue, transports }
}
const toView = (rows: { id: string; status: string }[]) => ({ id: rows[0]!.id, status: rows[0]!.status }) as never

async function seedSent(sessionId: string, n: number, at: Date) {
  for (let i = 0; i < n; i++) {
    await db.insert(messages).values({ sessionId, phone: PHONE, content: { text: `m${i}` }, status: 'sent', createdAt: at })
  }
}

const req = (sessionId: string) => ({ sessionId, phone: PHONE, content: { text: 'oi' }, actor: 'api' })
const reject = (p: Promise<unknown>) => p.then(() => undefined, (e: SendRejectedError) => e)

describe('ordem e curto-circuito (AC-T09-01)', () => {
  it('gates espiões rodam na ordem; o primeiro que falha interrompe', async () => {
    const calls: GateName[] = []
    const spy = (name: GateName, fail = false): Gate => async () => {
      calls.push(name)
      if (fail) throw new SendRejectedError('CONTACT_NOT_ALLOWED', 'no')
    }
    const gates = Object.fromEntries(GATE_ORDER.map((g) => [g, spy(g)])) as Record<GateName, Gate>
    const p1 = new SendPipeline({ db, gates })
    await p1.runGates(req('x'))
    expect(calls).toEqual([...GATE_ORDER])

    calls.length = 0
    const p2 = new SendPipeline({ db, gates: { ...gates, contactAllowed: spy('contactAllowed', true) } })
    const err = (await reject(p2.runGates(req('x'))))!
    expect(calls).toEqual(['auth', 'sessionExists', 'connected', 'contactAllowed'])
    expect(err).toMatchObject({ code: 'CONTACT_NOT_ALLOWED', status: 403, gate: 'contactAllowed' })
  })
})

describe('gates default', () => {
  it('auth / sessionExists / connected', async () => {
    const { pipeline, transports, queue } = setup()
    expect(await reject(pipeline.send({ ...req('x'), actor: '' }))).toMatchObject({ code: 'UNAUTHORIZED', status: 401, gate: 'auth' })
    expect(await reject(pipeline.send(req('nope')))).toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404 })
    expect(await reject(pipeline.send(req('00000000-0000-4000-8000-000000000000')))).toMatchObject({ code: 'SESSION_NOT_FOUND' })
    for (const status of ['NEW', 'PAUSED'] as const) {
      const id = await session(status)
      transports.set(id, new FakeTransport())
      expect(await reject(pipeline.send(req(id)))).toMatchObject({ code: 'SESSION_NOT_CONNECTED', status: 409, gate: 'connected' })
    }
    // DEGRADED envia em ritmo reduzido: passa pelo gate connected.
    const degraded = await session('DEGRADED')
    transports.set(degraded, new FakeTransport())
    expect((await reject(pipeline.send(req(degraded))))?.gate).not.toBe('connected')
    const noTransport = await session('STABLE')
    expect(await reject(pipeline.send(req(noTransport)))).toMatchObject({ code: 'SESSION_NOT_CONNECTED' })
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('contactAllowed: inexistente, sem consentimento, opt-out → 403; permitido enfileira', async () => {
    const { pipeline, transports, queue } = setup()
    const id = await session('STABLE', 30 * DAY_MS)
    transports.set(id, new FakeTransport())
    expect(await reject(pipeline.send(req(id)))).toMatchObject({ code: 'CONTACT_NOT_ALLOWED', details: { reason: 'contact_not_found' } })
    await contact({ consent: false })
    expect(await reject(pipeline.send(req(id)))).toMatchObject({ code: 'CONTACT_NOT_ALLOWED', details: { reason: 'no_consent' } })
    await db.update(contacts).set({ consent: true, optOut: true })
    expect(await reject(pipeline.send(req(id)))).toMatchObject({ code: 'CONTACT_NOT_ALLOWED', details: { reason: 'opt_out' } })
    expect(await db.select().from(messages)).toHaveLength(0)
    await db.update(contacts).set({ optOut: false })
    const msg = await pipeline.send(req(id))
    expect(msg).toMatchObject({ status: 'queued' })
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, phone: PHONE, contactId: expect.any(String) }))
  })

  it('warmupLimit: limite do dia de warm-up (T10) → 429 WARMUP_LIMIT', async () => {
    const { pipeline, transports } = setup()
    await contact()
    const id = await session('WARMING', 2 * 60 * 60_000) // dia 0: limite 20
    transports.set(id, new FakeTransport())
    // folga no rate limit para isolar o warm-up
    await new SessionLimitsService(db, { now: () => now }).set(id, { perMinute: 1000, perHour: 1000, perDay: 1000 })
    await seedSent(id, 20, new Date(now.getTime() - 60 * 60_000))
    expect(await reject(pipeline.send(req(id)))).toMatchObject({ code: 'WARMUP_LIMIT', status: 429, gate: 'warmupLimit', details: { limit: 20, sent: 20, day: 0 } })
  })

  it('warm-up conta só o dia atual do cronograma; completo não limita', async () => {
    const { pipeline, transports } = setup()
    await contact()
    const id = await session('WARMING', DAY_MS + 60_000) // dia 1: limite 36
    transports.set(id, new FakeTransport())
    await new SessionLimitsService(db, { now: () => now }).set(id, { perMinute: 1000, perHour: 1000, perDay: 1000 })
    await seedSent(id, 30, new Date(now.getTime() - DAY_MS)) // dia 0
    await expect(pipeline.send(req(id))).resolves.toBeDefined()
  })

  it('rateLimit: janelas minuto/hora/dia → 429 RATE_LIMIT', async () => {
    const { pipeline, transports } = setup()
    await contact()
    const id = await session('STABLE', 30 * DAY_MS)
    transports.set(id, new FakeTransport())
    await seedSent(id, DEFAULT_SEND_LIMITS.perMinute, new Date(now.getTime() - 10_000))
    expect(await reject(pipeline.send(req(id)))).toMatchObject({ code: 'RATE_LIMIT', status: 429, gate: 'rateLimit', details: { window: 'minute', limit: 5 } })
  })

  it('mensagens canceladas não contam', async () => {
    const { pipeline, transports } = setup()
    await contact()
    const id = await session('STABLE', 30 * DAY_MS)
    transports.set(id, new FakeTransport())
    await seedSent(id, 5, new Date(now.getTime() - 10_000))
    await db.update(messages).set({ status: 'cancelled' }).where(eq(messages.sessionId, id))
    await expect(pipeline.send(req(id))).resolves.toBeDefined()
  })
})

describe('limites por sessão (AC-T09-05)', () => {
  it('computeEffectiveLimits nunca passa do warm-up nem do configurado', () => {
    const configured = { perMinute: 50, perHour: 5000, perDay: 50000 }
    expect(computeEffectiveLimits({ configured, reductionFactor: 1, state: 'WARMING', warmupDailyLimit: 20 })).toMatchObject({ perDay: 20, perHour: 5000, perMinute: 50 })
    expect(computeEffectiveLimits({ configured: DEFAULT_SEND_LIMITS, reductionFactor: 1, state: 'STABLE', warmupDailyLimit: null })).toMatchObject(DEFAULT_SEND_LIMITS)
    expect(computeEffectiveLimits({ configured: DEFAULT_SEND_LIMITS, reductionFactor: 0.5, state: 'STABLE', warmupDailyLimit: null })).toMatchObject({ perMinute: 2, perHour: 50, perDay: 400 })
    expect(computeEffectiveLimits({ configured: DEFAULT_SEND_LIMITS, reductionFactor: 1, state: 'DEGRADED', warmupDailyLimit: null })).toMatchObject({ perDay: 400 })
    // fator > 1 é ignorado (nunca aumenta)
    expect(computeEffectiveLimits({ configured: DEFAULT_SEND_LIMITS, reductionFactor: 3, state: 'STABLE', warmupDailyLimit: null })).toMatchObject(DEFAULT_SEND_LIMITS)
  })

  it('set manual, reduce automático só diminui, PUT manual zera a redução', async () => {
    const svc = new SessionLimitsService(db, { now: () => now })
    const id = await session('STABLE', 30 * DAY_MS)
    const initial = await svc.get(id)
    expect(initial.configured).toEqual(DEFAULT_SEND_LIMITS)
    expect(initial.reductionFactor).toBe(1)

    await svc.set(id, { perDay: 100 })
    expect((await svc.get(id)).configured).toEqual({ ...DEFAULT_SEND_LIMITS, perDay: 100 })

    let v = await svc.reduce(id, 0.5, 'test')
    expect(v.reductionFactor).toBe(0.5)
    expect(v.effective.perDay).toBe(50)
    v = await svc.reduce(id, 2, 'tentativa de aumento')
    expect(v.reductionFactor).toBe(0.5)
    for (let i = 0; i < 10; i++) v = await svc.reduce(id, 0.5, 'x')
    expect(v.reductionFactor).toBeCloseTo(0.1)
    expect(v.reductionReason).toBe('x')

    v = await svc.set(id, { perDay: 200 })
    expect(v.reductionFactor).toBe(1)
    expect(v.effective.perDay).toBe(200)
    await expect(svc.set(id, { perDay: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('configurar acima do warm-up não aumenta o efetivo', async () => {
    const svc = new SessionLimitsService(db, { now: () => now })
    const id = await session('WARMING', 0)
    const v = await svc.set(id, { perMinute: 500, perHour: 5000, perDay: 50000 })
    expect(v.warmupDailyLimit).toBe(20)
    expect(new SessionLimitsService({ db }).db).toBe(db)
    expect(v.configured.perDay).toBe(50000)
    expect(v.warmup.dailyLimit).toBe(20)
    expect(v.effective.perDay).toBe(20)
    const [row] = await db.select().from(sessionLimits).where(eq(sessionLimits.sessionId, id))
    expect(row!.perDay).toBe(50000)
  })

  it('limites reduzidos entram no rateLimit do pipeline', async () => {
    const { pipeline, transports } = setup()
    await contact()
    const id = await session('STABLE', 30 * DAY_MS)
    transports.set(id, new FakeTransport())
    await pipeline.limits.set(id, { perMinute: 4 })
    await pipeline.limits.reduce(id, 0.5, 'test') // perMinute 2
    await seedSent(id, 2, new Date(now.getTime() - 5_000))
    expect(await reject(pipeline.send(req(id)))).toMatchObject({ code: 'RATE_LIMIT', details: { limit: 2 } })
  })
})

// Mantém `now` estável entre testes.
beforeEach(() => {
  now = new Date('2026-09-24T12:00:00Z')
})
