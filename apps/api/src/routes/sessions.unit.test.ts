import { describe, expect, it, vi } from 'vitest'
import { InvalidTransitionError, SessionError, type SessionView } from '@wsm/core'
import { createApp } from '../app'
import { captureLogger, fakeDb, fakeRedis } from '../test-utils'
import type { SessionsControl } from './sessions'

const TOKEN = 't0k'
const ID = '11111111-1111-4111-8111-111111111111'

const view = (over: Partial<SessionView> = {}): SessionView => ({
  id: ID,
  name: 's',
  phone: '+5511999990001',
  status: 'NEW',
  state: 'NEW',
  proxyId: null,
  note: null,
  requiresRestart: false,
  warmupStartedAt: null,
  lastConnectedAt: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  ...over,
})

function setup(overrides: Partial<SessionsControl> = {}) {
  const sessions: SessionsControl = {
    create: vi.fn(async (input) => view({ name: input.name, phone: input.phone, note: input.note ?? null })),
    list: vi.fn(async () => [view()]),
    get: vi.fn(async (id) => {
      if (id !== ID) throw new SessionError('SESSION_NOT_FOUND', 'nope')
      return view()
    }),
    startQr: vi.fn(async () => view()),
    getQr: vi.fn(async () => ({ qr: 'data:image/png;base64,AAA', generatedAt: new Date(0).toISOString() })),
    requestPairingCode: vi.fn(async () => ({ code: 'ABCD1234' })),
    pause: vi.fn(async () => view({ status: 'PAUSED', state: 'PAUSED' })),
    resume: vi.fn(async () => view({ status: 'WARMING', state: 'WARMING' })),
    restart: vi.fn(async () => view()),
    logout: vi.fn(async () => {
      throw new InvalidTransitionError('DISCONNECTED', 'logout')
    }),
    remove: vi.fn(async () => ({ deletedProxyId: null })),
    ...overrides,
  }
  const { db, audits } = fakeDb()
  const app = createApp({ db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: TOKEN, sessions })
  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { app, req, sessions, audits }
}

describe('/api/sessions', () => {
  it('POST cria (201) e audita', async () => {
    const { req, audits } = setup()
    const res = await req('POST', '/api/sessions', { name: 'a', phone: '+5511999990001', note: 'x' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ id: ID, status: 'NEW', name: 'a' })
    expect(audits[0]).toMatchObject({ action: 'session.create', targetType: 'session', targetId: ID })
  })

  it('POST sem número (QR) → 201; o número fica para a conexão', async () => {
    const { req, sessions } = setup()
    expect((await req('POST', '/api/sessions', { name: 'a' })).status).toBe(201)
    expect((await req('POST', '/api/sessions', { name: 'b', phone: null })).status).toBe(201)
    expect(sessions.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'a', phone: null }))
  })

  it('POST com telefone fora do E.164 → 400 VALIDATION_ERROR', async () => {
    const { req, sessions } = setup()
    for (const phone of ['11999990001', '+0123', 'abc']) {
      const res = await req('POST', '/api/sessions', { name: 'a', phone })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: string; details: { issues: { path: string }[] } } }
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.details.issues[0]!.path).toBe('phone')
    }
    expect(sessions.create).not.toHaveBeenCalled()
  })

  it('POST com proxy em uso → 409 PROXY_IN_USE', async () => {
    const { req } = setup({
      create: async () => {
        throw new SessionError('PROXY_IN_USE', 'in use')
      },
    })
    const res = await req('POST', '/api/sessions', { name: 'a', phone: '+5511999990001', proxyId: ID })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PROXY_IN_USE')
  })

  it('GET lista e detalhe; id inválido/inexistente → 404 SESSION_NOT_FOUND', async () => {
    const { req } = setup()
    // T17 (AC-T17-05): a view traz `proxy` (null quando a sessão não tem proxy).
    expect(await (await req('GET', '/api/sessions')).json()).toEqual({ items: [{ ...view(), proxy: null }] })
    expect((await req('GET', `/api/sessions/${ID}`)).status).toBe(200)
    for (const id of ['xyz', '22222222-2222-4222-8222-222222222222']) {
      const res = await req('GET', `/api/sessions/${id}`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SESSION_NOT_FOUND')
    }
  })

  it('QR: POST 202 inicia; GET devolve data URL', async () => {
    const { req, sessions } = setup()
    expect((await req('POST', `/api/sessions/${ID}/qr`)).status).toBe(202)
    expect(sessions.startQr).toHaveBeenCalledWith(ID)
    expect(await (await req('GET', `/api/sessions/${ID}/qr`)).json()).toMatchObject({ qr: expect.stringMatching(/^data:image\/png/) })
  })

  it('pairing-code: corpo opcional; phone validado', async () => {
    const { req, sessions } = setup()
    expect(await (await req('POST', `/api/sessions/${ID}/pairing-code`)).json()).toEqual({ code: 'ABCD1234' })
    expect(sessions.requestPairingCode).toHaveBeenLastCalledWith(ID, undefined)
    await req('POST', `/api/sessions/${ID}/pairing-code`, { phone: '+5511988887777' })
    expect(sessions.requestPairingCode).toHaveBeenLastCalledWith(ID, '+5511988887777')
    expect((await req('POST', `/api/sessions/${ID}/pairing-code`, { phone: '123' })).status).toBe(400)
  })

  it('ações: 200 com a sessão; transição inválida → 409 INVALID_TRANSITION', async () => {
    const { req, audits } = setup()
    const res = await req('POST', `/api/sessions/${ID}/pause`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'PAUSED' })
    expect(audits.at(-1)).toMatchObject({ action: 'session.pause', targetId: ID })
    expect((await req('POST', `/api/sessions/${ID}/resume`)).status).toBe(200)
    expect((await req('POST', `/api/sessions/${ID}/restart`)).status).toBe(200)
    const bad = await req('POST', `/api/sessions/${ID}/logout`)
    expect(bad.status).toBe(409)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION')
  })

  it('DELETE exclui (204) e audita; inexistente → 404 sem chamar o worker', async () => {
    const { req, sessions, audits } = setup({ remove: vi.fn(async () => ({ deletedProxyId: 'p1' })) })
    const res = await req('DELETE', `/api/sessions/${ID}`)
    expect(res.status).toBe(204)
    expect(sessions.remove).toHaveBeenCalledWith(ID)
    expect(audits.at(-1)).toMatchObject({ action: 'session.delete', targetType: 'session', targetId: ID, detail: { name: 's', deletedProxyId: 'p1' } })
    const missing = await req('DELETE', '/api/sessions/22222222-2222-4222-8222-222222222222')
    expect(missing.status).toBe(404)
    expect((await req('DELETE', '/api/sessions/nao-e-uuid')).status).toBe(404)
    expect(sessions.remove).toHaveBeenCalledTimes(1)
  })

  it('exige auth', async () => {
    const { app } = setup()
    expect((await app.request('/api/sessions')).status).toBe(401)
    expect((await app.request(`/api/sessions/${ID}`, { method: 'DELETE' })).status).toBe(401)
  })
})
