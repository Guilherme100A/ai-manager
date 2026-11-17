import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, ApiRequestError, request, setFetch } from './api'
import { clearToken, getToken, setToken, TOKEN_KEY, REMEMBERED_TOKEN_KEY } from './auth'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) {
    return this.data.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.data.set(k, v)
  }
  removeItem(k: string) {
    this.data.delete(k)
  }
}

let session: MemoryStorage
let local: MemoryStorage
let calls: Array<{ url: string; init: RequestInit | undefined }>
let responder: (url: string, init?: RequestInit) => Response

beforeEach(() => {
  session = new MemoryStorage()
  local = new MemoryStorage()
  Object.assign(globalThis, { sessionStorage: session, localStorage: local })
  calls = []
  responder = () => new Response(JSON.stringify({ items: [] }), { status: 200 })
  setFetch(async (url, init) => {
    calls.push({ url, init })
    return responder(url, init)
  })
  clearToken()
})

afterEach(() => {
  clearToken()
})

describe('token (AC-T12-01)', () => {
  it('fica em memória e sessionStorage, nunca em localStorage', () => {
    setToken('abc')
    expect(getToken()).toBe('abc')
    expect(session.getItem(TOKEN_KEY)).toBe('abc')
    expect(local.data.size).toBe(0)
    clearToken()
    expect(getToken()).toBeNull()
    expect(session.getItem(TOKEN_KEY)).toBeNull()
  })

  it('recupera o token do sessionStorage (reload da aba)', () => {
    session.setItem(TOKEN_KEY, 'persisted')
    expect(getToken()).toBe('persisted')
  })
})

describe('cliente da API', () => {
  it('remember opt-in is sent explicitly while legacy login stays compatible', async () => {
    responder = () => new Response(JSON.stringify({ token: 'synthetic-token', expiresAt: new Date(Date.now() + 86400000).toISOString() }), { status: 200 })
    await api.login('admin', 'synthetic-password', true)
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({ username: 'admin', password: 'synthetic-password', remember: true })
    expect(local.getItem(REMEMBERED_TOKEN_KEY)).toBeNull()
  })
  it('an old request returning 401 does not erase a newer remembered login', async () => {
    let release!: (response: Response) => void
    setFetch(() => new Promise<Response>(resolve => { release = resolve }))
    setToken('old-synthetic-token')
    const pending = request('/api/auth/me')
    setToken('new-synthetic-token', { remember: true, expiresAt: new Date(Date.now() + 86400000).toISOString() })
    release(new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }))
    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(getToken()).toBe('new-synthetic-token')
    expect(local.getItem(REMEMBERED_TOKEN_KEY)).not.toBeNull()
  })
  it('usa caminho relativo e Bearer token', async () => {
    setToken('t0k')
    await api.sessions()
    expect(calls[0]!.url).toBe('/api/sessions')
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer t0k')
  })

  it('401 limpa o token (volta ao login); no login não limpa', async () => {
    setToken('bad')
    responder = () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no' } }), { status: 401 })
    await expect(api.sessions()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' })
    expect(getToken()).toBeNull()
    setToken('keep')
    await expect(api.login('admin', 'errada')).rejects.toBeInstanceOf(ApiRequestError)
    expect(getToken()).toBe('keep')
    expect(calls.at(-1)).toMatchObject({ url: '/api/auth/login', init: { method: 'POST' } })
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({ username: 'admin', password: 'errada' })
  })

  it('erro no formato da SPEC 3.4 vira ApiRequestError com code e message', async () => {
    responder = () => new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'phone must be E.164' } }), { status: 400 })
    const err = await api.createSession({ name: 'a', phone: '1' }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiRequestError)
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'phone must be E.164' })
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ name: 'a', phone: '1' })
  })

  it('204 resolve sem corpo; import CSV manda text/csv', async () => {
    responder = () => new Response(null, { status: 204 })
    await expect(api.deleteWebhook('w1')).resolves.toBeUndefined()
    expect(calls[0]).toMatchObject({ url: '/api/webhooks/w1', init: { method: 'DELETE' } })
    responder = () => new Response(JSON.stringify({ imported: 1, rejected: [], contacts: [] }), { status: 200 })
    await api.importContacts('phone\n+5511999990001')
    expect((calls[1]!.init?.headers as Record<string, string>)['content-type']).toBe('text/csv')
  })

  it('messages monta a query; metrics devolve null em 404', async () => {
    await api.messages({ sessionId: 's1' })
    expect(calls[0]!.url).toBe('/api/messages?sessionId=s1&limit=500')
    responder = () => new Response('not found', { status: 404 })
    await expect(api.metrics()).resolves.toBeNull()
    expect(calls[1]!.url).toBe('/metrics')
    responder = () => {
      throw new Error('offline')
    }
    await expect(api.metrics()).resolves.toBeNull()
  })

  it('request sem token não manda authorization', async () => {
    await request('/api/x')
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBeUndefined()
  })
})
