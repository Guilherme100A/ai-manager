import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { captureLogger, fakeDb, fakeRedis } from '../test-utils'
const A = '11111111-1111-4111-8111-111111111111'
const config = { enabled: true, query: 'jogos', maxEntriesPerDay: 5, targetSessionId: null }
function setup() {
  const { db, audits } = fakeDb()
  const sessions = {
    getGroupAutomation: vi.fn(async () => ({ config, capacity: { dailyEntryLimit: 1, usedEntries24h: 0 } })),
    configureGroupAutomation: vi.fn(async () => ({ config })),
    tickGroupAutomation: vi.fn(async () => ({ queued: true })),
  }
  const app = createApp({ db, redis: fakeRedis(), apiToken: 'token', logger: captureLogger().logger, sessions: sessions as never })
  const request = (method: string, body?: unknown, suffix = '', authorized = true) => app.request(`/api/sessions/${A}/groups/automation${suffix}`, {
    method, headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer token' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { request, sessions, audits }
}
describe('configuração de entrada automática', () => {
  it('lê, configura e solicita ciclo sem aguardar pesquisa nem entrar na API', async () => {
    const s = setup()
    expect((await s.request('GET')).status).toBe(200)
    expect((await s.request('PUT', config)).status).toBe(200)
    expect(s.sessions.configureGroupAutomation).toHaveBeenCalledWith(A, config)
    expect(s.audits[0]).toMatchObject({ action: 'group.automation.configure' })
    expect((await s.request('POST', undefined, '/run')).status).toBe(202)
    expect(s.sessions.tickGroupAutomation).toHaveBeenCalledWith(A)
  })
  it('autenticação é obrigatória e só aceita limites de entrada, sem tráfego recebido', async () => {
    const s = setup()
    expect((await s.request('PUT', config, '', false)).status).toBe(401)
    for (const value of [{ ...config, maxEntriesPerDay: 0 }, { ...config, maxEntriesPerDay: 21 }, { ...config, targetSessionId: A }, { ...config, receivedLimit: 20 }]) {
      expect((await s.request('PUT', value)).status).toBe(400)
    }
    expect(s.sessions.configureGroupAutomation).not.toHaveBeenCalled()
  })
})
