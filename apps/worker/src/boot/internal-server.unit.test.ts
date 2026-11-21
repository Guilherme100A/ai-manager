import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONVERSATION_CONFIG, DEFAULT_GROUP_AUTOMATION, InvalidTransitionError, SessionError, TransportNotConnectedError, type ConversationConfig, type GroupAutomationConfig, type FakeTransport, type WaTransport } from '@wsm/core'
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

describe('MCP pairing bridge', () => {
  function safeTargets() {
    return targets({
      preparePairing: vi.fn(async () => ({ id: 'chip-a', status: 'NEW' })),
      getConversation: vi.fn(async () => ({ config: { enabled: true, mode: 'rotating', intervalMinutes: 10 } })),
      configureConversation: vi.fn(async () => ({})),
      getGroupAutomation: vi.fn(async () => ({ config: { enabled: true, query: 'saved query', maxEntriesPerDay: 2 } })),
      configureGroupAutomation: vi.fn(async () => ({})),
    })
  }
  it('disables only the target chip automations, preserving their other settings, without starting QR or sending', async () => {
    const t = safeTargets(), app = createInternalApp({ token: TOKEN, targets: t })
    const proxy = { protocol: 'socks5', host: 'proxy.test', port: 1080, username: 'u', password: 'private' }
    expect(await (await rpc(app, 'sessions', 'preparePairing', ['chip-a', { proxy }])).json()).toEqual({ result: { id: 'chip-a', status: 'NEW' } })
    expect(t.sessions.preparePairing).toHaveBeenCalledExactlyOnceWith('chip-a', { proxy })
    expect(t.sessions.configureConversation).toHaveBeenCalledExactlyOnceWith('chip-a', { enabled: false, mode: 'rotating', intervalMinutes: 10 })
    expect(t.sessions.configureGroupAutomation).toHaveBeenCalledExactlyOnceWith('chip-a', { enabled: false, query: 'saved query', maxEntriesPerDay: 2 })
    expect(t.sessions.startQr).not.toHaveBeenCalled()
    expect(t.messages.enqueue).not.toHaveBeenCalled()
  })
  it('requires internal authentication before any preparation', async () => {
    const t = safeTargets(), app = createInternalApp({ token: TOKEN, targets: t })
    expect((await rpc(app, 'sessions', 'preparePairing', ['chip-a', {}], {})).status).toBe(401)
    expect(t.sessions.preparePairing).not.toHaveBeenCalled()
  })
  it('refuses an older worker or unsupported options before changing anything', async () => {
    const t = safeTargets()
    const app = createInternalApp({ token: TOKEN, targets: t })
    expect(await (await rpc(app, 'sessions', 'preparePairing', ['chip-a', { enableAutomation: true }])).json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    t.sessions.configureGroupAutomation = undefined
    expect(await (await rpc(app, 'sessions', 'preparePairing', ['chip-a', {}])).json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(t.sessions.preparePairing).not.toHaveBeenCalled()
  })
  it.each([
    { args: [] }, { args: [null] }, { args: [123] }, { args: [{}] }, { args: [' '] },
    { args: ['chip-a', null] }, { args: ['chip-a', []] }, { args: ['chip-a', {}, 'extra'] },
    { args: ['chip-a', { proxy: false }] }, { args: ['chip-a', { proxy: 'http://user:secret@host' }] },
    { args: ['chip-a', { proxy: { protocol: 'http', host: 'host', port: '8080' } }] },
    { args: ['chip-a', { proxy: { protocol: 'http', host: 'host', port: 0 } }] },
    { args: ['chip-a', { proxy: { protocol: 'http', host: 'host', port: 8080, password: 123 } }] },
    { args: ['chip-a', { proxy: { protocol: 'http', host: 'host', port: 8080, extra: true } }] },
  ])('rejects malformed pairing arguments without side effects: $args', async ({ args }) => {
    const t = safeTargets(), app = createInternalApp({ token: TOKEN, targets: t })
    expect(await (await rpc(app, 'sessions', 'preparePairing', args)).json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(t.sessions.preparePairing).not.toHaveBeenCalled()
    expect(t.sessions.getConversation).not.toHaveBeenCalled()
    expect(t.sessions.configureConversation).not.toHaveBeenCalled()
    expect(t.sessions.configureGroupAutomation).not.toHaveBeenCalled()
  })
  it.each(['preparePairing', 'getConversation', 'configureConversation', 'getGroupAutomation', 'configureGroupAutomation'] as const)('requires capability %s before side effects', async capability => {
    const t = safeTargets()
    const prepare = t.sessions.preparePairing
    t.sessions[capability] = undefined
    const app = createInternalApp({ token: TOKEN, targets: t })
    expect(await (await rpc(app, 'sessions', 'preparePairing', ['chip-a'])).json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(prepare).not.toHaveBeenCalled()
  })
  it.each([undefined, null])('preserves proxy omission/null across RPC: %j', async proxy => {
    const t = safeTargets(), app = createInternalApp({ token: TOKEN, targets: t })
    const input = proxy === undefined ? {} : { proxy }
    await rpc(app, 'sessions', 'preparePairing', proxy === undefined ? ['chip-a'] : ['chip-a', input])
    expect(t.sessions.preparePairing).toHaveBeenCalledExactlyOnceWith('chip-a', input)
  })
  const preparationSteps = ['getConversation', 'getGroupAutomation', 'preparePairing', 'configureConversation', 'configureGroupAutomation'] as const
  it.each(preparationSteps)('propagates a failure in %s without success or subsequent operations', async step => {
    const t = safeTargets()
    const failure = new Error(`${step} unavailable`)
    vi.spyOn(t.sessions, step).mockRejectedValueOnce(failure)
    const app = createInternalApp({ token: TOKEN, targets: t })
    expect(await (await rpc(app, 'sessions', 'preparePairing', ['chip-a'])).json()).toEqual({ error: serializeError(failure) })
    expect(t.sessions[step]).toHaveBeenCalledOnce()
    for (const next of preparationSteps.slice(preparationSteps.indexOf(step) + 1)) {
      expect(t.sessions[next]).not.toHaveBeenCalled()
    }
  })
  it.each(preparationSteps)('waits for %s to resolve before returning success', async step => {
    const t = safeTargets()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(t.sessions, step).mockImplementationOnce(async () => {
      entered()
      await gate
      return step === 'getConversation' || step === 'getGroupAutomation'
        ? { config: { enabled: true } }
        : { id: 'chip-a', status: 'NEW' }
    })
    const app = createInternalApp({ token: TOKEN, targets: t })
    let settled = false
    const response = Promise.resolve(rpc(app, 'sessions', 'preparePairing', ['chip-a'])).then(async res => {
      const body = await res.json()
      settled = true
      return body
    })
    try {
      await started
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      for (const next of preparationSteps.slice(preparationSteps.indexOf(step) + 1)) {
        expect(t.sessions[next]).not.toHaveBeenCalled()
      }
    } finally { release() }
    expect(await response).toEqual({ result: { id: 'chip-a', status: 'NEW' } })
    for (const operation of preparationSteps) expect(t.sessions[operation]).toHaveBeenCalledOnce()
  })
  it('preserves partial state on the second write failure and safely completes a later retry', async () => {
    const initial = {
      conversation: { ...DEFAULT_CONVERSATION_CONFIG, enabled: true, topic: 'saved topic' },
      groups: { ...DEFAULT_GROUP_AUTOMATION, enabled: true, query: 'saved query' },
    }
    const chips = new Map([
      ['chip-a', structuredClone(initial)],
      ['chip-b', structuredClone(initial)],
    ])
    const t = safeTargets()
    t.sessions.getConversation = vi.fn(async id => ({ config: { ...chips.get(id)!.conversation } }))
    t.sessions.getGroupAutomation = vi.fn(async id => ({ config: { ...chips.get(id)!.groups } }))
    t.sessions.configureConversation = vi.fn(async (id: string, config: ConversationConfig) => {
      chips.get(id)!.conversation = { ...config }
    })
    const failure = new Error('group configuration write failed')
    t.sessions.configureGroupAutomation = vi.fn(async (id: string, config: GroupAutomationConfig) => {
      chips.get(id)!.groups = { ...config }
    }).mockRejectedValueOnce(failure)
    const app = createInternalApp({ token: TOKEN, targets: t })
    const prepare = () => rpc(app, 'sessions', 'preparePairing', ['chip-a', {}])

    expect(await (await prepare()).json()).toEqual({ error: serializeError(failure) })
    expect(chips.get('chip-a')).toEqual({
      conversation: { ...initial.conversation, enabled: false }, groups: initial.groups,
    })
    expect(chips.get('chip-b')).toEqual(initial)
    expect(t.sessions.configureConversation).toHaveBeenCalledOnce()
    expect(t.sessions.configureGroupAutomation).toHaveBeenCalledOnce()

    expect(await (await prepare()).json()).toEqual({ result: { id: 'chip-a', status: 'NEW' } })
    expect(chips.get('chip-a')).toEqual({
      conversation: { ...initial.conversation, enabled: false },
      groups: { ...initial.groups, enabled: false },
    })
    expect(chips.get('chip-b')).toEqual(initial)
    for (const operation of preparationSteps) {
      const mock = vi.mocked(t.sessions[operation]!)
      expect(mock).toHaveBeenCalledTimes(2)
      expect(mock.mock.calls.map(args => args[0])).toEqual(['chip-a', 'chip-a'])
    }
    expect(t.sessions.preparePairing).toHaveBeenNthCalledWith(1, 'chip-a', {})
    expect(t.sessions.preparePairing).toHaveBeenNthCalledWith(2, 'chip-a', {})
    expect(t.sessions.startQr).not.toHaveBeenCalled()
    expect(t.sessions.getQr).not.toHaveBeenCalled()
    expect(t.sessions.requestPairingCode).not.toHaveBeenCalled()
    expect(t.sessions.restart).not.toHaveBeenCalled()
    expect(t.sessions.getTransport).not.toHaveBeenCalled()
    expect(t.sessions.tickConversation).toBeUndefined()
    expect(t.sessions.tickGroupAutomation).toBeUndefined()
    expect(t.messages.enqueue).not.toHaveBeenCalled()
  })
  it('propagates a pending queue failure without changing automation settings', async () => {
    const t = safeTargets()
    t.sessions.preparePairing = vi.fn(async () => { throw new SessionError('VALIDATION_ERROR', 'Pending outbound queue') })
    const app = createInternalApp({ token: TOKEN, targets: t })
    expect(await (await rpc(app, 'sessions', 'preparePairing', ['chip-a', {}])).json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(t.sessions.configureConversation).not.toHaveBeenCalled()
    expect(t.sessions.configureGroupAutomation).not.toHaveBeenCalled()
  })
})

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
