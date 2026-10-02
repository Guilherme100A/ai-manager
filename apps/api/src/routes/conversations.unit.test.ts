import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONVERSATION_CONFIG } from '@wsm/core'
import { createApp } from '../app'
import { captureLogger, fakeDb, fakeRedis } from '../test-utils'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
function setup() {
  const { db, audits } = fakeDb()
  const config = { ...DEFAULT_CONVERSATION_CONFIG, mode: 'fixed' as const, enabled: true, targetSessionId: B }
  const sessions = { getConversation: vi.fn(async () => ({ config })), configureConversation: vi.fn(async () => ({ config })), tickConversation: vi.fn(async () => ({ queued: true })) }
  const app = createApp({ db, redis: fakeRedis(), apiToken: 'token', logger: captureLogger().logger, sessions: sessions as never })
  const request = (method: string, body?: unknown, authorized = true, suffix = '') => app.request(`/api/sessions/${A}/conversation${suffix}`, {
    method, headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer token' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { config, sessions, audits, request }
}
describe('API de conversas', () => {
  it('configura, audita, consulta e solicita ciclo no worker', async () => {
    const s = setup()
    expect((await s.request('GET')).status).toBe(200)
    expect((await s.request('PUT', s.config)).status).toBe(200)
    expect(s.sessions.configureConversation).toHaveBeenCalledWith(A, s.config)
    expect(s.audits[0]).toMatchObject({ action: 'conversation.configure' })
    expect((await s.request('POST', undefined, true, '/run')).status).toBe(202)
  })
  it('exige autenticação, outro destinatário e limites válidos', async () => {
    const s = setup()
    expect((await s.request('PUT', s.config, false)).status).toBe(401)
    for (const config of [{ ...s.config, targetSessionId: A }, { ...s.config, targetSessionId: null }, { ...s.config, intervalMinutes: 0 }, { ...s.config, turnsPerConversation: 100 }, { ...s.config, maxMessagesPerDay: 0 }, { ...s.config, extra: true }]) {
      expect((await s.request('PUT', config)).status).toBe(400)
    }
    expect(s.sessions.configureConversation).not.toHaveBeenCalled()
  })
  it('rodízio permite habilitar conta sem destinatário fixo', async () => {
    const s = setup()
    const config = { ...s.config, mode: 'rotating', targetSessionId: null }
    expect((await s.request('PUT', config)).status).toBe(200)
    expect(s.sessions.configureConversation).toHaveBeenCalledWith(A, config)
  })
})
