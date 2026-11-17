import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class Storage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}
let session: Storage, local: Storage
const expiry = () => new Date(Date.now() + 86400000).toISOString()
beforeEach(() => {
  vi.resetModules()
  session = new Storage(); local = new Storage()
  vi.stubGlobal('sessionStorage', session); vi.stubGlobal('localStorage', local)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('remembered login storage', () => {
  it('default login remains in sessionStorage and does not persist across reopening', async () => {
    const auth = await import('./auth')
    auth.setToken('synthetic-token')
    expect(local.data.size).toBe(0)
    session.data.clear(); vi.resetModules()
    expect((await import('./auth')).getToken()).toBeNull()
  })
  it('opt-in persists only token and expiry, and restores after the tab/browser session closes', async () => {
    const auth = await import('./auth')
    auth.setToken('synthetic-token', { remember: true, expiresAt: expiry() })
    const value = JSON.parse(local.getItem(auth.REMEMBERED_TOKEN_KEY)!)
    expect(Object.keys(value).sort()).toEqual(['expiresAt', 'token'])
    session.data.clear(); vi.resetModules()
    expect((await import('./auth')).getToken()).toBe('synthetic-token')
    expect(session.getItem(auth.TOKEN_KEY)).toBe('synthetic-token')
  })
  it.each(['null', '{}', 'not-json', JSON.stringify({ token: 'synthetic-token', expiresAt: '2000-01-01T00:00:00Z' })])('discards invalid or expired persistent storage', async raw => {
    const auth = await import('./auth')
    local.setItem(auth.REMEMBERED_TOKEN_KEY, raw)
    expect(auth.getToken()).toBeNull()
    expect(local.getItem(auth.REMEMBERED_TOKEN_KEY)).toBeNull()
  })
  it('logout clears the remembered token; a delayed old 401 preserves a new login', async () => {
    const auth = await import('./auth')
    auth.setToken('new-synthetic-token', { remember: true, expiresAt: expiry() })
    auth.clearToken('old-synthetic-token')
    expect(auth.getToken()).toBe('new-synthetic-token')
    auth.clearToken('new-synthetic-token')
    expect(auth.getToken()).toBeNull()
    expect(session.data.size + local.data.size).toBe(0)
  })
  it('unchecking remember replaces an older remembered login with a session-only login', async () => {
    const auth = await import('./auth')
    auth.setToken('old-synthetic-token', { remember: true, expiresAt: expiry() })
    auth.setToken('new-synthetic-token')
    expect(local.data.size).toBe(0)
    session.data.clear(); vi.resetModules()
    expect((await import('./auth')).getToken()).toBeNull()
  })
  it('persistent storage disabled does not prevent the current login', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } })
    const auth = await import('./auth')
    auth.setToken('synthetic-token', { remember: true, expiresAt: expiry() })
    expect(auth.getToken()).toBe('synthetic-token')
  })
  it('can restore from persistent storage when sessionStorage is blocked', async () => {
    const auth = await import('./auth')
    local.setItem(auth.REMEMBERED_TOKEN_KEY, JSON.stringify({ token: 'synthetic-token', expiresAt: expiry() }))
    vi.stubGlobal('sessionStorage', { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } })
    expect(auth.getToken()).toBe('synthetic-token')
  })
})
