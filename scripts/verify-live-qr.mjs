// Operator-authorized verification on GitHub only. Never persist QR payloads,
// credentials, screenshots or customer data. Only the selected QR may be started.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Run live QR verification on GitHub only')
const token = process.env.QR_SMOKE_PANEL_TOKEN
const sessionId = process.env.QR_SESSION_ID
const connectionId = process.env.QR_CONNECTION_ID || ''
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
assert.ok(token?.startsWith('wsm1.') && uuid.test(sessionId || '') && (!connectionId || uuid.test(connectionId)), 'Missing authorized verification inputs')
const base = 'http://148.113.255.144:8080'
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const browser = await chromium.launch({ headless: true })
const contexts = [], checks = [], errors = [], blocked = []
let stage = 'initialize', failed = false
const authHeaders = { authorization: 'Bearer ' + token }
async function pngVisible(image, width) {
  await image.waitFor({ state: 'visible', timeout: 65000 })
  await image.evaluate(img => img.decode())
  assert.ok(await image.evaluate(img => img.naturalWidth > 0 && img.src.startsWith('data:image/png;base64,')))
  const box = await image.boundingBox()
  assert.ok(box && box.x >= 0 && box.x + box.width <= width, 'QR must fit viewport')
}
try {
  for (const width of [390, 1440]) {
    stage = `panel-${width}`
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    contexts.push(context)
    await context.addInitScript(t => sessionStorage.setItem('wsm.token', t), token)
    await context.route('**/*', async route => {
      const req = route.request(), p = new URL(req.url()).pathname
      const authentication = ['/api/crm/sso', '/crm/api/auth/sso', '/crm/api/auth/logout'].includes(p)
      const selectedQr = req.method() === 'POST' && (p === `/api/sessions/${sessionId}/qr` || (connectionId && p === `/crm/api/connections/${connectionId}/connect`))
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !authentication && !selectedQr) {
        blocked.push('business mutation'); await route.abort(); return
      }
      await route.continue()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)
    page.on('pageerror', () => errors.push('pageerror'))
    page.on('response', r => {
      const p = new URL(r.url()).pathname
      if ((p.startsWith('/api/') || p.startsWith('/crm/api/')) && r.status() >= 400 && !(p === '/crm/api/auth/profile' && r.status() === 401)) errors.push('api-response')
    })
    const current = await context.request.get(`${base}/api/sessions/${sessionId}`, { headers: authHeaders })
    assert.equal(current.status(), 200)
    assert.ok(['NEW', 'DISCONNECTED'].includes((await current.json()).status), 'Selected session must still await pairing; never disconnect a paired device')
    await page.goto(base + '/#/sessions')
    await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"] [data-testid="session-link"]`).click()
    await page.getByTestId('session-gen-qr').click()
    await pngVisible(page.getByTestId('qr-image'), width)
    checks.push({ width, panel_qr_png: true, fits_viewport: true, session_duplicated: false })

    for (const name of ['home', 'sessions', 'session-links', 'contacts', 'groups', 'report', 'autoreply', 'alerts', 'ai', 'spy']) {
      stage = `navigation-${width}-${name}`
      const link = page.getByTestId('nav-' + name)
      if (!(await link.isVisible())) await page.getByTestId('nav-toggle').click()
      await link.click()
      await page.waitForFunction(expected => location.hash === expected, name === 'home' ? '#/' : '#/' + name)
      await page.locator('.main h1').first().waitFor()
      await page.waitForTimeout(700)
      checks.push({ width, page: name, opened: true })
    }

    stage = `crm-${width}`
    if (!(await page.getByTestId('nav-crm').isVisible())) await page.getByTestId('nav-toggle').click()
    await page.getByTestId('nav-crm').click()
    const frame = page.frameLocator('[data-testid="crm-frame"]')
    await frame.getByTestId(width < 1024 ? 'shell-mobile-header' : 'shell-sidebar').waitFor({ timeout: 60000 })
    const resources = await context.request.get(base + '/crm/api/offers/resources')
    assert.equal(resources.status(), 200, 'Active CRM Offers gate must be preserved')
    checks.push({ width, crm_sso: true, offers_gate_enabled: true })
    if (connectionId) {
      stage = `crm-qr-${width}`
      const link = frame.getByTestId('nav-item-connections')
      if (!(await link.isVisible())) await frame.getByTestId('shell-drawer-open').click()
      await link.click()
      const listing = await context.request.get(base + '/crm/api/connections')
      assert.equal(listing.status(), 200)
      const connection = (await listing.json()).items.find(c => c.id === connectionId)
      assert.ok(connection, 'Selected CRM connection must exist')
      assert.ok(['pending', 'connecting', 'disconnected', 'banned'].includes(connection.status), 'Never disconnect a paired CRM device')
      if (connection.origin === 'ai-manager') {
        // Imported sessions are deliberately managed by the main panel.
        const s = await context.request.get(`${base}/api/sessions/${connection.session_id}`, { headers: authHeaders })
        assert.equal(s.status(), 200)
        checks.push({ width, crm_connection_managed_in_panel: true })
      } else {
        await frame.getByTestId(`connections-item-actions-${connectionId}`).filter({ visible: true }).click()
        await frame.getByTestId(`connections-action-connect-${connectionId}`).click()
        await pngVisible(frame.getByTestId('connections-qr-image'), width)
        checks.push({ width, crm_qr_png: true, fits_viewport: true })
      }
    }
    await context.request.post(base + '/crm/api/auth/logout', { headers: { 'x-requested-with': 'crm' }, data: {} })
    await context.close()
  }
  assert.equal(errors.length, 0, 'Live API or JavaScript failure')
  assert.equal(blocked.length, 0, 'Unexpected business mutation')
  console.log(JSON.stringify({ passed: true, browser_location: 'GitHub runner', checks, messages_sent: 0, payments_created: 0, qr_payloads_logged: false }))
} catch {
  failed = true
  console.error('Live QR verification failed at ' + stage + '; no QR payload or credentials logged')
} finally {
  for (const c of contexts) {
    try { await c.request.post(base + '/crm/api/auth/logout', { headers: { 'x-requested-with': 'crm' }, data: {} }) } catch {}
    try { await c.close() } catch {}
  }
  try { await fetch(base + '/api/auth/logout', { method: 'POST', headers: authHeaders, signal: AbortSignal.timeout(15000) }) } catch {}
  await browser.close()
}
if (failed) process.exitCode = 1
