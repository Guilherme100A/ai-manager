import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { dashboardLoginSessions, auditLogs, createDb, createTempDatabase, type Database, type TempDatabase } from '@wsm/db'
import { eq } from 'drizzle-orm'
import { createApp } from '../app'
import { REMEMBERED_SESSION_TTL_MS } from '../auth'
import { signToken } from '../auth/token'
import { captureLogger, fakeRedis } from '../test-utils'

let temp: TempDatabase, db: Database, now: Date
const initial = new Date('2026-11-17T12:00:00Z')
const secret = 'synthetic-db-remembered-secret'
beforeAll(async () => { temp = await createTempDatabase({ migrate: true, prefix: 'wsm_remembered_auth' }); db = createDb(temp.url, { max: 4 }) })
afterAll(async () => { await db?.$client.end(); await temp?.drop() })
beforeEach(async () => { now = initial; await db.delete(dashboardLoginSessions); await db.delete(auditLogs) })
const setup = () => createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: 'synthetic-integration-token', auth: { secret, password: 'synthetic-password', now: () => now } })
const call = (app: ReturnType<typeof createApp>, method: string, path: string, token?: string, body?: unknown) => app.request(path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
async function login(app: ReturnType<typeof createApp>, remember?: boolean) {
  const response = await call(app, 'POST', '/api/auth/login', undefined, { username: 'admin', password: 'synthetic-password', ...(remember === undefined ? {} : { remember }) })
  expect(response.status).toBe(200)
  return response.json() as Promise<{ token: string; expiresAt: string }>
}

describe('remembered login through authenticated API and database', () => {
  it('defaults to existing 12-hour login with no durable record; opt-in persists only a hash for 30 days', async () => {
    const app = setup()
    const regular = await login(app)
    expect(Date.parse(regular.expiresAt) - initial.getTime()).toBe(12 * 3600000)
    expect(await db.select().from(dashboardLoginSessions)).toHaveLength(0)
    const remembered = await login(app, true)
    expect(Date.parse(remembered.expiresAt) - initial.getTime()).toBe(REMEMBERED_SESSION_TTL_MS)
    const rows = await db.select().from(dashboardLoginSessions)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows).includes(remembered.token)).toBe(false)
    expect(JSON.stringify(rows).includes('synthetic-password')).toBe(false)
    expect((await call(app, 'GET', '/api/auth/me', remembered.token)).status).toBe(200)
  })
  it('rejects invalid credentials, invalid remember input and signed claims without a database record', async () => {
    const app = setup()
    expect((await call(app, 'POST', '/api/auth/login', undefined, { username: 'admin', password: 'wrong', remember: true })).status).toBe(401)
    expect((await call(app, 'POST', '/api/auth/login', undefined, { username: 'admin', password: 'synthetic-password', remember: 'true' })).status).toBe(400)
    const unrecorded = signToken(secret, { sub: 'admin', role: 'admin', iat: now.getTime(), exp: now.getTime() + REMEMBERED_SESSION_TTL_MS, remember: true })
    expect((await call(app, 'GET', '/api/auth/me', unrecorded)).status).toBe(401)
    expect(await db.select().from(dashboardLoginSessions)).toHaveLength(0)
  })
  it('a new API instance preserves three logins; logout revokes only its own durable record', async () => {
    const first = setup(), sessions = await Promise.all([login(first, true), login(first, true), login(first, true)])
    expect(new Set(sessions.map(s => s.token)).size).toBe(3)
    expect((await call(first, 'POST', '/api/auth/logout', sessions[0]!.token)).status).toBe(204)
    const restarted = setup()
    const statuses = await Promise.all(sessions.map(async s => (await call(restarted, 'GET', '/api/auth/me', s.token)).status))
    expect(statuses).toEqual([401, 200, 200])
    expect((await db.select().from(dashboardLoginSessions)).filter(s => s.revokedAt)).toHaveLength(1)
    now = new Date(initial.getTime() + REMEMBERED_SESSION_TTL_MS)
    expect((await call(restarted, 'GET', '/api/auth/me', sessions[1]!.token)).status).toBe(401)
  })
  it('modified or shortened database expiry fails closed and integration bearer remains compatible', async () => {
    const app = setup(), session = await login(app, true)
    await db.update(dashboardLoginSessions).set({ expiresAt: new Date(initial.getTime() - 1) }).where(eq(dashboardLoginSessions.username, 'admin'))
    expect((await call(app, 'GET', '/api/auth/me', session.token)).status).toBe(401)
    expect((await call(app, 'GET', '/api/auth/me', 'synthetic-integration-token')).status).toBe(200)
  })
})

async function startChild(at: Date) {
  const require = createRequire(import.meta.url)
  const child = fork(fileURLToPath(new URL('../auth/fixtures/remembered-server.ts', import.meta.url)), [], {
    execArgv: ['--conditions=development', '--import', require.resolve('tsx/esm')], silent: true,
    env: { ...process.env, AUTH_TEST_DATABASE_URL: temp.url, AUTH_TEST_NOW: at.toISOString(), ANTIBAN_MODE: 'passthrough' },
  })
  return new Promise<{ child: ChildProcess; base: string }>((resolve, reject) => {
    let ready = false
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Auth fixture startup timed out; credentials withheld')) }, 30000)
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Auth fixture process error')) })
    child.once('exit', () => { clearTimeout(timeout); if (!ready) reject(new Error('Auth fixture exited before readiness')) })
    child.once('message', (message: { ready?: boolean; port?: number }) => { clearTimeout(timeout); if (message.ready && message.port) { ready = true; resolve({ child, base: 'http://127.0.0.1:' + message.port }) } else reject(new Error('Invalid fixture readiness message')) })
  })
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return
  await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve() }, 5000); child.once('exit', () => { clearTimeout(timer); resolve() }); child.send('stop') })
}
it('real Node process restart retains valid logins and rejects revoked or expired credentials', async () => {
  let running = await startChild(initial)
  const request = (path: string, token?: string, body?: unknown) => fetch(running.base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  try {
    const sessions: Array<{ token: string }> = []
    for (let i = 0; i < 3; i++) {
      const response = await request('/api/auth/login', undefined, { username: 'admin', password: 'synthetic-password', remember: true })
      expect(response.status).toBe(200); sessions.push(await response.json() as { token: string })
    }
    expect((await request('/api/auth/logout', sessions[0]!.token, {})).status).toBe(204)
    await stopChild(running.child)
    running = await startChild(initial)
    expect(await Promise.all(sessions.map(async s => (await request('/api/auth/me', s.token)).status))).toEqual([401, 200, 200])
    await stopChild(running.child)
    running = await startChild(new Date(initial.getTime() + REMEMBERED_SESSION_TTL_MS))
    expect(await Promise.all(sessions.map(async s => (await request('/api/auth/me', s.token)).status))).toEqual([401, 401, 401])
  } finally { await stopChild(running.child) }
}, 90000)
