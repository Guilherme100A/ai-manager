// Copied into the reconstructed CRM by CI only. All services/providers are disposable/fake.
import { beforeAll, afterAll, it, expect } from 'vitest'
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, extname, join } from 'node:path'
import { startSystem, tenant, type System } from './setup'
let sys: System, t: Awaited<ReturnType<typeof tenant>>
const secret = 'fake-ci-sso-' + randomBytes(16).toString('hex')
beforeAll(async () => { process.env.CRM_SSO_SECRET = secret; sys = await startSystem(); t = await tenant(sys) })
afterAll(async () => { process.env.SHARED_OFFERS_COMPANY_ID = ''; await sys?.close() })
it('real local read-only MCP initializes, lists flows, denies mutation and revokes immediately with gate empty', async () => {
  process.env.SHARED_OFFERS_COMPANY_ID = ''
  expect((await t.c.get('/api/offers')).status).toBe(404)
  const made = await t.c.post('/api/mcp_credentials', { mcp_credential: { name: 'CI read only', access: 'read' } }); expect(made.status).toBe(201)
  let id = 0
  const rpc = async (method: string, params: any = {}) => {
    const r = await sys.app.request('/api/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + made.body.token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    return { status: r.status, body: await r.json() as any }
  }
  try {
    expect((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-only', version: '1' } })).status).toBe(200)
    const list = await rpc('tools/list'); expect(list.body.result.tools.map((x: any) => x.name)).toContain('list_flows')
    const read = await rpc('tools/call', { name: 'list_flows', arguments: {} }); expect(read.status).toBe(200); expect(read.body.result.isError).not.toBe(true)
    const write = await rpc('tools/call', { name: 'create_flow', arguments: { name: 'must-not-exist' } }); expect(Boolean(write.body.error || write.body.result?.isError)).toBe(true)
    expect((await t.c.delete('/api/mcp_credentials/' + made.body.mcp_credential.id)).status).toBe(200)
    expect((await rpc('tools/list')).status).toBe(401)
  } finally { await t.c.delete('/api/mcp_credentials/' + made.body.mcp_credential.id) }
})
it('panel login -> SSO iframe -> Offers navigation works without reload; empty gate hides and denies Offers', async () => {
  const panelDir = process.env.PANEL_SOURCE_DIR!, { createTempDatabase, createDb } = await import(panelDir + '/packages/db/src/index.ts'), { createApp } = await import(panelDir + '/apps/api/src/app.ts')
  const tmp = await createTempDatabase({ migrate: true, prefix: 'crm_ci_panel' }), db = createDb(tmp.url)
  const username = 'ci-' + randomBytes(5).toString('hex'), password = 'CI-' + randomBytes(10).toString('hex')
  const panel = createApp({ db, redis: sys.prod.redis, logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } }, apiToken: 'ci-unused', auth: { secret: randomBytes(32).toString('hex'), username, password }, crmEnv: { CRM_SSO_SECRET: secret } } as any)
  await sys.q("INSERT INTO crm.companies(name,slug) VALUES('Shared CI company','ai-manager') ON CONFLICT DO NOTHING")
  const company = (await sys.q("SELECT id FROM crm.companies WHERE slug='ai-manager'"))[0].id
  process.env.SHARED_OFFERS_COMPANY_ID = company // Fixture UUID only, never a deployment variable.
  const panelRoot = resolve(panelDir, 'apps/dashboard/dist'), crmRoot = resolve(process.env.CRM_EMBEDDED_DIST!)
  const server = createServer(async (req, res) => {
    try {
      const p = new URL(req.url!, 'http://ci').pathname
      if (p.startsWith('/api/') || p.startsWith('/crm/api/')) {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const crm = p.startsWith('/crm/api/'), abort = new AbortController(); res.on('close', () => abort.abort())
        const response = await (crm ? sys.app : panel).request(crm ? req.url!.replace(/^\/crm/, '') : req.url!, { method: req.method, headers: req.headers as any, signal: abort.signal, ...(!['GET', 'HEAD'].includes(req.method!) ? { body: Buffer.concat(chunks) } : {}) })
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        if (response.headers.get('content-type')?.includes('text/event-stream')) { const reader = response.body!.getReader(); res.on('close', () => void reader.cancel().catch(() => {})); for (;;) { const item = await reader.read(); if (item.done) break; res.write(Buffer.from(item.value)) } res.end() }
        else res.end(Buffer.from(await response.arrayBuffer()))
        return
      }
      const crm = p.startsWith('/crm/'), root = crm ? crmRoot : panelRoot, relative = crm ? p.slice(4) : p, asset = resolve(root, '.' + relative), file = asset.startsWith(root + '/') && existsSync(asset) && extname(asset) ? asset : resolve(root, 'index.html')
      res.setHeader('content-type', extname(file) === '.js' ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'text/html'); res.end(readFileSync(file))
    } catch { if (!res.headersSent) res.statusCode = 500; res.end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + (server.address() as any).port
  const browser = await chromium.launch({ headless: true })
  try {
    for (const enabled of [true, false]) {
      process.env.SHARED_OFFERS_COMPANY_ID = enabled ? company : ''
      const context = await browser.newContext(), page = await context.newPage()
      await page.goto(base + '/#/login'); await page.getByTestId('login-username').fill(username); await page.getByTestId('login-password').fill(password); await page.getByTestId('login-submit').click(); await page.getByTestId('nav-crm').click()
      const frame = page.frameLocator('[data-testid="crm-frame"]'); await frame.getByTestId('nav-item-chats').waitFor()
      if (enabled) { await frame.getByTestId('nav-item-offers').click(); await frame.getByRole('heading', { name: 'Ofertas compartilhadas' }).waitFor(); expect((await page.request.get(base + '/crm/api/offers')).status()).toBe(200) }
      else { expect(await frame.getByTestId('nav-item-offers').count()).toBe(0); expect((await page.request.get(base + '/crm/api/offers')).status()).toBe(404) }
      await page.screenshot({ path: join(process.env.CRM_REPORT_DIR!, enabled ? 'sso-offers-enabled.png' : 'sso-gate-empty.png'), fullPage: true }); await context.close()
    }
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await db.$client.end(); await tmp.drop(); process.env.SHARED_OFFERS_COMPANY_ID = '' }
})
