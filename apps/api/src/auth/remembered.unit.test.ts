import { describe, expect, it } from 'vitest'
import { AuthService, REMEMBERED_SESSION_TTL_MS } from './service'
import { signToken } from './token'

const secret = 'synthetic-remembered-auth-secret'
const initial = new Date('2026-11-17T12:00:00Z')
describe('remembered login issuance and server bounds', () => {
  it('opt-in issues a 30-day session; default login keeps its configured TTL', () => {
    const auth = new AuthService({ secret, password: 'synthetic-password', sessionTtlMs: 1000, now: () => initial }, {})
    const regular = auth.login('admin', 'synthetic-password', 'ip')
    const remembered = auth.login('admin', 'synthetic-password', 'ip', true)
    if (!regular.ok || !remembered.ok) throw new Error('Fixture login failed')
    expect(Date.parse(regular.result.expiresAt) - initial.getTime()).toBe(1000)
    expect(Date.parse(remembered.result.expiresAt) - initial.getTime()).toBe(REMEMBERED_SESSION_TTL_MS)
    expect(auth.verify(regular.result.token)?.remember).toBeUndefined()
    expect(auth.verify(remembered.result.token)?.remember).toBe(true)
  })
  it('expires exactly at 30 days and revokes only one of three sessions of the same account', () => {
    let now = initial
    const auth = new AuthService({ secret, password: 'synthetic-password', now: () => now }, {})
    const sessions = Array.from({ length: 3 }, () => auth.login('admin', 'synthetic-password', 'ip', true))
    const tokens = sessions.map(s => { if (!s.ok) throw new Error('Fixture login failed'); return s.result.token })
    expect(new Set(tokens).size).toBe(3)
    auth.revoke(tokens[0]!)
    expect(tokens.map(t => !!auth.verify(t))).toEqual([false, true, true])
    now = new Date(initial.getTime() + REMEMBERED_SESSION_TTL_MS - 1)
    expect(!!auth.verify(tokens[1]!)).toBe(true)
    now = new Date(now.getTime() + 1)
    expect(tokens.map(t => !!auth.verify(t))).toEqual([false, false, false])
  })
  it('does not issue remembered sessions with invalid credentials', () => {
    const auth = new AuthService({ secret, password: 'synthetic-password', now: () => initial }, {})
    expect(auth.login('admin', 'wrong', 'ip', true).ok).toBe(false)
    expect(auth.login('another-account', 'synthetic-password', 'ip', true).ok).toBe(false)
  })
  it('rejects an overlong remembered claim or a different account even with a valid signature', () => {
    const auth = new AuthService({ secret, password: 'synthetic-password', now: () => initial }, {})
    const claims = { sub: 'admin', role: 'admin' as const, iat: initial.getTime(), exp: initial.getTime() + REMEMBERED_SESSION_TTL_MS, remember: true as const }
    expect(!!auth.verify(signToken(secret, { ...claims, exp: claims.exp + 1 }))).toBe(false)
    expect(!!auth.verify(signToken(secret, { ...claims, sub: 'other-account' }))).toBe(false)
  })
})
