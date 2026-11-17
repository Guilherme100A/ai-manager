import { test } from 'node:test'
import assert from 'node:assert/strict'
import { secureClient, revokeTemporarySessions } from './live-login-transport.mjs'

for (const origin of ['http://example.test', 'https://u:private@example.test', 'https://example.test/path', 'https://example.test/?credential=private']) {
  test('rejects an unsafe smoke origin before sending credentials: ' + new URL(origin).protocol + new URL(origin).pathname, () => {
    let called = false
    assert.throws(() => secureClient(origin, () => { called = true }, {}), /HTTPS/)
    assert.equal(called, false)
  })
}
test('rejects disabled certificate validation', () => assert.throws(() => secureClient('https://example.test', () => {}, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /HTTPS/))
for (const path of ['http://example.test/api/auth/me', 'https://other.example.test/api/auth/me']) {
  test('refuses an origin override before sending any credential: ' + new URL(path).protocol, () => {
    let called = false
    const request = secureClient('https://example.test', () => { called = true }, {})
    assert.throws(() => request(path), /Cross-origin/); assert.equal(called, false)
  })
}
test('every HTTPS request forbids redirects even if the caller asks to follow', async () => {
  const calls = []
  const request = secureClient('https://example.test', async (...args) => { calls.push(args); return { status: 401 } }, {})
  await request('/api/auth/me', { redirect: 'follow', headers: { authorization: 'Bearer synthetic-token' } })
  assert.equal(calls[0][0], 'https://example.test/api/auth/me')
  assert.equal(calls[0][1].redirect, 'error')
})
test('confirms 401 for all three sessions and each CRM cookie', async () => {
  const request = secureClient('https://example.test', async (_url, init) => ({ status: init.method === 'POST' ? 204 : 401 }), {})
  const result = await revokeTemporarySessions(request, [{ token: 'a' }, { token: 'b' }, { token: 'c' }], new Set(['cookie-a', 'cookie-b']))
  assert.deepEqual(result, { panelTokens401: true, crmCookiesRevoked: true, panelChecked: 3, crmChecked: 2 })
  assert.equal(JSON.stringify(result).includes('cookie-a'), false)
})
test('partial cleanup failure still attempts the other sessions and reports failure without credentials', async () => {
  let calls = 0
  const result = await revokeTemporarySessions(async path => {
    calls++
    if (calls === 1) throw new Error('synthetic-private-value')
    return { status: path.endsWith('/me') ? 200 : 204 }
  }, [{ token: 'private-a' }, { token: 'private-b' }, { token: 'private-c' }], new Set(['private-cookie']))
  assert.equal(result.panelChecked, 3); assert.equal(result.crmChecked, 1)
  assert.equal(result.panelTokens401, false); assert.equal(result.crmCookiesRevoked, false)
  assert.equal(JSON.stringify(result).includes('private'), false)
})
