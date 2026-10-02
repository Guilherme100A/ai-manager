import { describe, expect, it, vi } from 'vitest'
import { InvalidTransitionError, SessionError, TransportNotConnectedError, type FakeTransport, type WaTransport } from '@wsm/core'
import { FakeControl } from './fake-control'
import { createInternalApp, serializeError, tokenOk, type BridgeTargets } from './internal-server'

const TOKEN = 'secret-token'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

function targets(over: Partial<BridgeTargets['sessions']> = {}): BridgeTargets {
  return {
    sessions: {
      create: vi.fn(async () => ({ id: 'n' })),
      list: vi.fn(async () => [{ id: 'a' }]),
      get: vi.fn(async (id: string) => {
        throw new SessionError('SESSION_NOT_FOUND', `session ${id} not found`)
      }),
      startQr: vi.fn(async () => ({})),
      getQr: vi.fn(async () => ({ qr: null })),
      requestPairingCode: vi.fn(async () => ({ code: 'X' })),
      pause: vi.fn(async () => {
        throw new InvalidTransitionError('NEW', 'pause', 'nope')
      }),
      resume: vi.fn(async () => ({})),
      restart: vi.fn(async () => ({})),
      logout: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({ deletedProxyId: null })),
      getTransport: vi.fn(() => undefined as WaTransport | undefined),
      isConnected: vi.fn(() => false),
      ...over,
    },
    messages: {
      get: vi.fn(async () => ({})),
      list: vi.fn(async () => []),
      events: vi.fn(async () => []),
      cancel: vi.fn(async () => ({})),
      enqueue: vi.fn(async (input) => ({ id: 'm1', ...input })),
    },
    health: { getHealth: vi.fn(async () => ({ score: 90 })) },
  }
}

const rpc = (app: ReturnType<typeof createInternalApp>, target: string, method: string, args: unknown[] = [], headers: Record<string, string> = auth) =>
  app.request('/internal/rpc', { method: 'POST', headers, body: JSON.stringify({ target, method, args }) })

describe('servidor interno — ponte RPC', () => {
  it('exige o token interno', async () => {
    const app = createInternalApp({ token: TOKEN, targets: targets() })
    expect((await rpc(app, 'sessions', 'list', [], {})).status).toBe(401)
    expect((await rpc(app, 'sessions', 'list', [], { authorization: 'Bearer errado' })).status).toBe(401)
    expect(tokenOk(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(tokenOk(undefined, TOKEN)).toBe(false)
  })

  it('chama o método e devolve {result}; lista fechada de métodos', async () => {
    const t = targets()
    const app = createInternalApp({ token: TOKEN, targets: t })
    expect(await (await rpc(app, 'sessions', 'list')).json()).toEqual({ result: [{ id: 'a' }] })
    const enq = await (await rpc(app, 'messages', 'enqueue', [{ sessionId: 's', phone: '+5511', content: { text: 'x' } }])).json()
    expect(enq).toMatchObject({ result: { id: 'm1', sessionId: 's' } })
    expect((await rpc(app, 'sessions', 'constructor')).status).toBe(400)
    expect((await rpc(app, 'sessions', 'getTransport')).status).toBe(400)
  })

  it('erros de domínio viajam serializados', async () => {
    const app = createInternalApp({ token: TOKEN, targets: targets() })
    expect(await (await rpc(app, 'sessions', 'get', ['x'])).json()).toEqual({
      error: { name: 'SessionError', message: 'session x not found', code: 'SESSION_NOT_FOUND' },
    })
    expect(await (await rpc(app, 'sessions', 'pause', ['x'])).json()).toMatchObject({
      error: { name: 'InvalidTransitionError', code: 'INVALID_TRANSITION', from: 'NEW', to: 'pause' },
    })
    expect(await (await rpc(app, 'sessions', 'fetchGroups', ['x'])).json()).toMatchObject({ error: { name: 'TransportNotConnectedError' } })
  })

  it('fetchGroups com transporte conectado', async () => {
    const transport = { fetchGroups: async () => [{ id: 'g', name: 'G', participants: 2, announce: false }] } as unknown as WaTransport
    const app = createInternalApp({ token: TOKEN, targets: targets({ getTransport: () => transport, isConnected: () => true }) })
    expect(await (await rpc(app, 'sessions', 'fetchGroups', ['s'])).json()).toEqual({ result: [{ id: 'g', name: 'G', participants: 2, announce: false }] })
  })

  it('serializeError', () => {
    expect(serializeError(new TransportNotConnectedError())).toMatchObject({ name: 'TransportNotConnectedError', code: 'TRANSPORT_NOT_CONNECTED' })
    expect(serializeError('x')).toEqual({ name: 'Error', message: 'x' })
  })
})

describe('servidor interno — controle do fake', () => {
  it('sem FakeControl (WA_TRANSPORT=baileys) as rotas /internal/fake/* não existem', async () => {
    const app = createInternalApp({ token: TOKEN, targets: targets() })
    for (const path of ['/internal/fake/boot', '/internal/fake/sessions/s/state']) {
      expect((await app.request(path, { headers: auth })).status).toBe(404)
    }
    expect((await app.request('/internal/fake/sessions/s/open', { method: 'POST', headers: auth })).status).toBe(404)
  })

  it('com FakeControl: estado, simulação, histórico durável e atrasos', async () => {
    const list = new Map<string, string[]>()
    const redis = {
      rpush: async (k: string, ...v: string[]) => void list.set(k, [...(list.get(k) ?? []), ...v]),
      lrange: async (k: string) => list.get(k) ?? [],
    }
    const fake = new FakeControl({ redis, bootId: 'boot-1' })
    const app = createInternalApp({ token: TOKEN, targets: targets(), fake })
    const post = (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: auth, body: JSON.stringify(body) })

    expect(await (await app.request('/internal/fake/boot', { headers: auth })).json()).toEqual({ bootId: 'boot-1' })
    expect((await post('/internal/fake/sessions/s1/open')).status).toBe(404)
    expect(await (await app.request('/internal/fake/sessions/s1/state', { headers: auth })).json()).toMatchObject({ exists: false, bootId: 'boot-1' })
    expect(await (await app.request('/internal/fake/sessions/s1/sent-history', { headers: auth })).json()).toEqual({ items: [] })

    const t = fake.factory('s1') as FakeTransport
    await t.connect({ sessionId: 's1', auth: {} as never })
    const qrs: string[] = []
    t.on('qr', (q) => void qrs.push(q))
    expect((await post('/internal/fake/sessions/s1/qr', { qr: 'Q1' })).status).toBe(200)
    expect(qrs).toEqual(['Q1'])
    expect((await post('/internal/fake/sessions/s1/open')).status).toBe(200)
    expect(t.connected).toBe(true)

    await t.sendMessage('5511@s.whatsapp.net', { text: 'oi' })
    const hist = (await (await app.request('/internal/fake/sessions/s1/sent-history', { headers: auth })).json()) as { items: { bootId: string }[] }
    expect(hist.items).toHaveLength(1)
    expect(hist.items[0]).toMatchObject({ to: '5511@s.whatsapp.net', content: { text: 'oi' }, bootId: 'boot-1' })
    const state = (await (await app.request('/internal/fake/sessions/s1/state', { headers: auth })).json()) as Record<string, unknown>
    expect(state).toMatchObject({ exists: true, connected: true, connectCalls: 1, lastConnect: { sessionId: 's1' } })

    expect((await post('/internal/fake/sessions/s1/fail-next-send', { statusCode: 403 })).status).toBe(200)
    await expect(t.sendMessage('x', { text: 'y' })).rejects.toMatchObject({ statusCode: 403 })

    const received: string[] = []
    t.on('message', (m) => void received.push(m.text ?? ''))
    expect((await post('/internal/fake/sessions/s1/receive', { from: '5511988887777@s.whatsapp.net', text: 'SAIR' })).status).toBe(200)
    expect(received).toEqual(['SAIR'])
    expect((await post('/internal/fake/sessions/s1/receive', {})).status).toBe(400)

    expect((await post('/internal/fake/sessions/s1/send-delay', { ms: 800 })).status).toBe(200)
    expect((await post('/internal/fake/sessions/s1/hold-before-send', { ms: 500 })).status).toBe(200)
    expect([fake.sendDelay('s1'), fake.holdBeforeSend('s1')]).toEqual([800, 500])
    expect((await post('/internal/fake/sessions/s1/send-delay', { ms: -1 })).status).toBe(400)

    expect((await post('/internal/fake/sessions/s1/close', { reason: 'forbidden', statusCode: 403 })).status).toBe(200)
    expect(t.connected).toBe(false)
    expect((await post('/internal/fake/sessions/s1/close', { reason: 'nope' })).status).toBe(400)
    expect((await app.request('/internal/fake/boot')).status).toBe(401)
  })
})
