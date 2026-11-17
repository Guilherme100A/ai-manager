// Runs only on the authorized CI browser, with short-lived test credentials revoked in finally.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { LOGIN_VERIFICATION_ORIGIN, secureClient, revokeTemporarySessions } from './live-login-transport.mjs'
const base = LOGIN_VERIFICATION_ORIGIN
const request = secureClient(base)
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'TLS verification must stay enabled')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Live browser must run on the authorized CI runner')
assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/, 'Unique CI run required for cleanup attribution')
const marker = 'AIManager-PersistentLogin-Smoke/' + process.env.GITHUB_RUN_ID
const key = 'wsm.remembered-session'
let sessions
try { sessions = JSON.parse(process.env.LOGIN_SMOKE_SESSIONS ?? '') } catch { throw new Error('Temporary login sessions missing; credentials withheld') }
assert.ok(Array.isArray(sessions) && sessions.length === 3, 'Three independent temporary sessions required')
for (const s of sessions) assert.ok(typeof s.token === 'string' && s.token && Date.parse(s.expiresAt) > Date.now(), 'Invalid temporary session metadata')
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const browser = await chromium.launch({ headless: true })
const contexts = [], crmCookies = new Set(), users = [], errors = [], blocked = []
let stage = 'initialize', failed = false
const allowed = new Set(['/api/auth/login', '/api/auth/logout', '/api/crm/sso', '/crm/api/auth/sso', '/crm/api/auth/logout'])
async function context(state) {
  const c = await browser.newContext({ ...(state ? { storageState: state } : {}), ignoreHTTPSErrors: false, userAgent: marker })
  contexts.push(c)
  await c.route('**/*', async route => {
    const request = route.request()
    if (new URL(request.url()).protocol === 'http:') { blocked.push('insecure-http'); await route.abort(); return }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !allowed.has(new URL(request.url()).pathname)) { blocked.push('unexpected-write'); await route.abort(); return }
    await route.continue()
  })
  return c
}
async function collectCookie(c) { const value = (await c.cookies()).find(cookie => cookie.name === 'crm_session')?.value; if (value) crmCookies.add(value) }
async function status(token) { return (await request('/api/auth/me', { headers: { authorization: 'Bearer ' + token } })).status }
try {
  const active = []
  for (let i = 0; i < 3; i++) {
    stage = 'restore-session-' + (i + 1)
    const s = sessions[i], c = await context(), page = await c.newPage()
    page.on('pageerror', () => errors.push('pageerror'))
    if (i === 2) await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(base + '/#/login')
    await page.getByTestId('login-remember').waitFor()
    assert.equal(await page.getByTestId('login-remember').isChecked(), false, 'Remember must be opt-in')
    if (i === 2) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile login must fit the viewport')
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    assert.ok(Date.parse(s.expiresAt) - Date.now() > 29 * 86400000, 'Remembered server session must last 30 days')
    await page.evaluate(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key, session: s })
    await page.reload(); await page.getByTestId('nav-crm').waitFor()
    assert.equal(await status(s.token), 200)
    await page.getByTestId('nav-crm').click()
    const frame = page.frameLocator('[data-testid="crm-frame"]')
    await frame.getByTestId('nav-item-offers').click()
    await frame.getByRole('heading', { name: 'Ofertas compartilhadas' }).waitFor()
    const profile = await c.request.get(base + '/crm/api/auth/profile'); assert.equal(profile.status(), 200)
    users.push((await profile.json()).user.id); await collectCookie(c)
    active.push(c)
  }
  assert.equal(new Set(users).size, 1, 'One shared account required')
  assert.equal(crmCookies.size, 3, 'CRM sessions must be independent')
  assert.equal(new Set(sessions.map(s => s.token)).size, 3, 'Panel sessions must be independent')
  stage = 'browser-reopen'
  const saved = await active[0].storageState(); await active[0].close()
  active[0] = await context(saved)
  const reopened = await active[0].newPage(); await reopened.goto(base + '/#/sessions'); await reopened.getByTestId('add-session').waitFor()
  assert.equal(await status(sessions[0].token), 200)
  assert.equal((await active[0].request.get(base + '/crm/api/auth/profile')).status(), 200)
  stage = 'mcp-login-restoration'
  let loginCalls = 0
  reopened.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/login') loginCalls++ })
  await reopened.goto(base + '/mcp-login.html?redirect=%2Foffers')
  await reopened.getByRole('heading', { name: 'Ofertas compartilhadas' }).waitFor()
  assert.equal(loginCalls, 0, 'Saved login must not send a password')
  await collectCookie(active[0])
  stage = 'isolated-logout'
  await reopened.goto(base + '/#/'); await reopened.getByTestId('nav-logout').click(); await reopened.getByTestId('login-username').waitFor()
  assert.equal(await status(sessions[0].token), 401)
  assert.equal(await reopened.evaluate(key => localStorage.getItem(key) === null, key), true)
  for (let i = 1; i < 3; i++) {
    assert.equal(await status(sessions[i].token), 200)
    assert.equal((await active[i].request.get(base + '/crm/api/auth/profile')).status(), 200)
  }
  stage = 'revoked-login-on-mcp-entry'
  await reopened.evaluate(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key, session: sessions[0] })
  await reopened.goto(base + '/mcp-login.html?redirect=%2Foffers')
  await reopened.locator('#error').waitFor({ state: 'visible' })
  assert.ok((await reopened.locator('#error').textContent()).includes('Sua sessão expirou'))
  assert.equal(await reopened.evaluate(key => localStorage.getItem(key) === null, key), true)
  stage = 'invalid-credential'
  await reopened.locator('#username').fill('synthetic-nonexistent-login-check')
  await reopened.locator('#password').fill('synthetic-invalid-password')
  await reopened.locator('#remember').check(); await reopened.locator('#submit').click()
  await reopened.waitForFunction(() => document.querySelector('#error')?.textContent?.includes('Usuário ou senha inválidos'))
  assert.equal(await reopened.evaluate(key => localStorage.getItem(key) === null, key), true)
  assert.equal(errors.length, 0, 'Browser JavaScript errors')
  assert.equal(blocked.length, 0, 'Unexpected business request blocked')
  console.log(JSON.stringify({ passed: true, same_account_sessions: 3, remembered_server_days: 30, mobile_login_layout: true, browser_reopen: true, panel_sso_crm: true, mcp_login: true, isolated_logout: true, revoked_and_invalid_rejected: true, business_writes: false }))
} catch {
  failed = true
  console.error('Persistent login browser verification failed at ' + stage + '; credentials and business data withheld')
} finally {
  for (const c of contexts) { try { await collectCookie(c) } catch { /* closed context */ } }
  const cleanup = await revokeTemporarySessions(request, sessions, crmCookies)
  for (const c of contexts) await c.close().catch(() => {})
  await browser.close()
  console.log(JSON.stringify({ cleanup: true, ...cleanup }))
  if (!cleanup.panelTokens401 || !cleanup.crmCookiesRevoked) failed = true
}
if (failed) process.exitCode = 1
