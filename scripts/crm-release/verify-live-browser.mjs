// Run only on GitHub after deployment. The operator supplies a short-lived panel
// token as an encrypted Actions secret, then removes it. No password is copied.
// Only authentication lifecycle writes are allowed; no business mutations.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Live browser verification runs only on GitHub')
const token = process.env.CRM_SMOKE_PANEL_TOKEN
if (!token?.startsWith('wsm1.')) throw Error('Temporary smoke session is missing')
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const base = 'http://148.113.255.144:8080'
const browser = await chromium.launch({ headless: true })
const contexts = [], errors = [], blocked = [], users = [], sessions = [], chipIds = []
let failed = false, stage = 'initialize'
try {
  for (let i = 0; i < 3; i++) {
    stage = `session-${i + 1}-navigation`
    const context = await browser.newContext()
    contexts.push(context)
    await context.addInitScript(t => sessionStorage.setItem('wsm.token', t), token)
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !['/api/crm/sso', '/crm/api/auth/sso', '/crm/api/auth/logout'].includes(url.pathname)) {
        blocked.push(url.pathname); await route.abort(); return
      }
      await route.continue()
    })
    const page = await context.newPage()
    page.on('pageerror', () => errors.push('pageerror'))
    await page.goto(base + '/#/')
    await page.getByTestId('nav-crm').click()
    const frame = page.frameLocator('[data-testid="crm-frame"]')
    await frame.getByTestId('nav-item-offers').click()
    await frame.getByRole('heading', { name: 'Ofertas compartilhadas' }).waitFor()
    // Waiting for a control populated by the Offers screen verifies rendered UI.
    await frame.getByLabel('Filtrar responsável', { exact: true }).waitFor()
    stage = `session-${i + 1}-read-checks`
    const profile = await context.request.get(base + '/crm/api/auth/profile')
    assert.equal(profile.status(), 200, 'Live CRM profile failed')
    users.push((await profile.json()).user.id)
    const resources = await context.request.get(base + '/crm/api/offers/resources')
    assert.equal(resources.status(), 200, 'Live Offers resources failed')
    const data = await resources.json()
    chipIds.push(data.connections.map(c => c.id).sort())
    const cookie = (await context.cookies()).find(c => c.name === 'crm_session')?.value
    assert.ok(cookie, 'Live CRM session absent'); sessions.push(cookie)
    const offers = await context.request.get(base + '/crm/api/offers')
    assert.equal(offers.status(), 200, 'Live Offers list failed')
  }
  stage = 'identity-and-logout-isolation'
  assert.equal(new Set(users).size, 1, 'Sessions must use one account')
  assert.equal(new Set(sessions).size, 3, 'Independent CRM sessions required')
  assert.deepEqual(chipIds[0], chipIds[1]); assert.deepEqual(chipIds[0], chipIds[2])
  const out = await contexts[0].request.post(base + '/crm/api/auth/logout', { headers: { 'x-requested-with': 'crm' }, data: {} })
  assert.equal(out.status(), 200)
  assert.equal((await contexts[0].request.get(base + '/crm/api/offers')).status(), 401)
  for (const c of contexts.slice(1)) assert.equal((await c.request.get(base + '/crm/api/offers')).status(), 200)
  assert.equal(errors.length, 0, 'Browser JavaScript error')
  assert.equal(blocked.length, 0, 'Unexpected business mutation requested by UI')
  console.log(JSON.stringify({ passed: true, same_account_sessions: 3, shared_chip_list: true, panel_sso_offers_navigation: true, logout_isolated: true, business_writes: false }))
} catch {
  failed = true
  // Never serialize browser errors, request headers, tokens or business records.
  console.error('Live CRM browser verification failed at ' + stage + '; no credentials or business data logged')
} finally {
  for (const c of contexts) {
    try { await c.request.post(base + '/crm/api/auth/logout', { headers: { 'x-requested-with': 'crm' }, data: {} }) } catch {}
    await c.close()
  }
  try { await fetch(base + '/api/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + token } }) } catch {}
  await browser.close()
}
if (failed) process.exitCode = 1
