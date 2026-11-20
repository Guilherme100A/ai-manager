// CI-owned browser acceptance: disposable panel + unchanged reconstructed CRM, fake providers only.
/* eslint-disable @typescript-eslint/no-explicit-any -- integration fixture */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { startSystem, type System } from './setup'

let sys: System, browser: Browser, server: Server, panelDb: any, temp: any, base: string, company: string
const contexts = new Set<BrowserContext>()
const secret = 'synthetic-sso-' + randomBytes(16).toString('hex')
const username = 'remember-ci-' + randomBytes(5).toString('hex'), password = 'synthetic-' + randomBytes(12).toString('hex')
const previous = { sso: process.env.CRM_SSO_SECRET, gate: process.env.SHARED_OFFERS_COMPANY_ID }
const storageKey = 'wsm.remembered-session'
beforeAll(async () => {
  process.env.CRM_SSO_SECRET = secret
  sys = await startSystem()
  const panelDir = process.env.PANEL_SOURCE_DIR!
  const { createTempDatabase, createDb } = await import(panelDir + '/packages/db/src/index.ts')
  const { createApp } = await import(panelDir + '/apps/api/src/app.ts')
  temp = await createTempDatabase({ migrate: true, prefix: 'crm_ci_remembered_panel' }); panelDb = createDb(temp.url)
  const panel = createApp({ db: panelDb, redis: sys.prod.redis, logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } }, apiToken: 'synthetic-unused', auth: { username, password, secret: randomBytes(32).toString('hex') }, crmEnv: { CRM_SSO_SECRET: secret } } as any)
  await sys.q("INSERT INTO crm.companies(name,slug) VALUES('Remembered login CI','ai-manager') ON CONFLICT DO NOTHING")
  company = (await sys.q("SELECT id FROM crm.companies WHERE slug='ai-manager'"))[0].id
  process.env.SHARED_OFFERS_COMPANY_ID = company
  const panelRoot = resolve(panelDir, 'apps/dashboard/dist'), crmRoot = resolve(process.env.CRM_EMBEDDED_DIST!)
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url!, 'http://ci').pathname
      if (pathname.startsWith('/api/') || pathname.startsWith('/crm/api/')) {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const crm = pathname.startsWith('/crm/api/'), abort = new AbortController(); res.on('close', () => abort.abort())
        const response = await (crm ? sys.app : panel).request(crm ? req.url!.replace(/^\/crm/, '') : req.url!, { method: req.method, headers: req.headers as any, signal: abort.signal, ...(!['GET', 'HEAD'].includes(req.method!) ? { body: Buffer.concat(chunks) } : {}) })
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const reader = response.body!.getReader(); res.on('close', () => void reader.cancel().catch(() => {}))
          for (;;) { const item = await reader.read(); if (item.done) break; res.write(Buffer.from(item.value)) } res.end()
        } else res.end(Buffer.from(await response.arrayBuffer()))
        return
      }
      const crm = pathname.startsWith('/crm/'), root = crm ? crmRoot : panelRoot, asset = resolve(root, '.' + (crm ? pathname.slice(4) : pathname))
      const file = asset.startsWith(root + '/') && existsSync(asset) && extname(asset) ? asset : resolve(root, 'index.html')
      const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
      res.setHeader('content-type', mime[extname(file)] ?? 'text/html'); res.end(readFileSync(file))
    } catch { if (!res.headersSent) res.statusCode = 500; res.end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('CI server address absent')
  base = 'http://127.0.0.1:' + address.port
  browser = await chromium.launch({ headless: true })
}, 120000)
afterAll(async () => {
  for (const context of contexts) await context.close()
  await browser?.close()
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
  await panelDb?.$client.end(); await temp?.drop(); await sys?.close()
  if (previous.sso === undefined) delete process.env.CRM_SSO_SECRET; else process.env.CRM_SSO_SECRET = previous.sso
  if (previous.gate === undefined) delete process.env.SHARED_OFFERS_COMPANY_ID; else process.env.SHARED_OFFERS_COMPANY_ID = previous.gate
})
async function newContext(state?: Awaited<ReturnType<BrowserContext['storageState']>>) {
  const context = await browser.newContext(state ? { storageState: state } : {})
  contexts.add(context); return context
}
async function reopened(context: BrowserContext) {
  const state = await context.storageState(); await context.close(); contexts.delete(context)
  return newContext(state)
}
async function panelStatus(context: BrowserContext, token: string) {
  return (await context.request.get(base + '/api/auth/me', { headers: { authorization: 'Bearer ' + token } })).status()
}
it('three remembered logins of one account survive reopen, enter real CRM by SSO, and logout remains isolated', async () => {
  const sessions: Array<{ context: BrowserContext; token: string }> = []
  const users: string[] = [], cookies: string[] = []
  for (let i = 0; i < 3; i++) {
    const context = await newContext(), page = await context.newPage()
    await page.goto(base + '/#/login')
    await page.getByTestId('login-username').fill(username); await page.getByTestId('login-password').fill(password)
    await page.getByTestId('login-remember').check(); await page.getByTestId('login-submit').click()
    await page.getByTestId('nav-item-offers').waitFor()
    const frame = page
    await frame.getByTestId('nav-item-offers').click()
    await frame.getByRole('heading', { name: 'Ofertas compartilhadas' }).waitFor()
    const profile = await context.request.get(base + '/crm/api/auth/profile'); expect(profile.status()).toBe(200)
    users.push((await profile.json()).user.id)
    cookies.push((await context.cookies()).find(c => c.name === 'crm_session')!.value)
    sessions.push({ context, token: await page.evaluate(() => sessionStorage.getItem('wsm.token')!) })
  }
  expect(new Set(users).size).toBe(1); expect(new Set(cookies).size).toBe(3)
  expect(new Set(sessions.map(s => s.token)).size).toBe(3)
  sessions[0]!.context = await reopened(sessions[0]!.context)
  const restored = await sessions[0]!.context.newPage(); await restored.goto(base + '/#/sessions')
  await restored.getByTestId('add-session').waitFor()
  expect(await panelStatus(sessions[0]!.context, sessions[0]!.token)).toBe(200)
  expect((await sessions[0]!.context.request.get(base + '/crm/api/auth/profile')).status()).toBe(200)
  const person = sessions[1]!, page = person.context.pages()[0]!
  await page.goto(base + '/#/'); await page.getByTestId('nav-logout').click(); await page.getByTestId('login-username').waitFor()
  expect(await panelStatus(person.context, person.token)).toBe(401)
  expect(await page.evaluate((k: string) => localStorage.getItem(k) === null, storageKey)).toBe(true)
  expect((await person.context.request.post(base + '/crm/api/auth/logout', { headers: { 'x-requested-with': 'crm' }, data: {} })).status()).toBe(200)
  expect((await person.context.request.get(base + '/crm/api/auth/profile')).status()).toBe(401)
  for (const s of [sessions[0]!, sessions[2]!]) {
    expect(await panelStatus(s.context, s.token)).toBe(200)
    expect((await s.context.request.get(base + '/crm/api/auth/profile')).status()).toBe(200)
  }
}, 120000)
it('mcp-login remembers login for real SSO, reopens without password, and rejects revoked/invalid credentials', async () => {
  let context = await newContext(), page = await context.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(base + '/mcp-login.html?redirect=%2Foffers')
  await page.locator('#username').fill(username); await page.locator('#password').fill(password)
  await page.locator('#remember').check(); await page.locator('#submit').click()
  await page.getByRole('heading', { name: 'Ofertas compartilhadas' }).waitFor()
  const token = await page.evaluate(() => sessionStorage.getItem('wsm.token')!)
  expect(await page.evaluate((p: string) => JSON.stringify({ ...localStorage }).includes(p), password)).toBe(false)
  context = await reopened(context); page = await context.newPage()
  let loginCalls = 0
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/login') loginCalls++ })
  await page.goto(base + '/mcp-login.html?redirect=%2Foffers')
  await page.getByRole('heading', { name: 'Ofertas compartilhadas' }).waitFor()
  expect(loginCalls).toBe(0)
  const hash = createHash('sha256').update(token).digest('hex')
  await panelDb.$client.query('UPDATE dashboard_login_sessions SET revoked_at=now() WHERE token_hash=$1', [hash])
  await page.goto(base + '/mcp-login.html?redirect=%2Foffers')
  await page.locator('#error').waitFor({ state: 'visible' })
  expect(await page.locator('#error').textContent()).toContain('Sua sessão expirou')
  expect(await page.evaluate((k: string) => localStorage.getItem(k) === null && sessionStorage.getItem('wsm.token') === null, storageKey)).toBe(true)
  await page.locator('#username').fill(username); await page.locator('#password').fill('wrong-synthetic-password')
  await page.locator('#remember').check(); await page.locator('#submit').click()
  await expect.poll(() => page.locator('#error').textContent()).toContain('Usuário ou senha inválidos')
  expect(await page.evaluate((k: string) => localStorage.getItem(k) === null, storageKey)).toBe(true)
}, 120000)
