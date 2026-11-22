// CI-only disposable rehearsal: real crm-web command, dashboard config and release API.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { TREE, command, composeArgs, read, validateManifest } from './lib.mjs'
import { waitForVisibleWithEvidence, captureBrowserFailure, hasFailureEvidence } from './nginx-browser-evidence.mjs'
import { createDiagnostic, mimeEvidence, composeLogEvidence, privateComposeConfig, finishBeforeTeardown } from './nginx-network-diagnostic.mjs'

function assertMissingAssetCache(policy) {
  assert.equal(policy, 'no-store', 'missing assets require exactly Cache-Control: no-store')
}
// Exercise the same assertion used by the real backend and proxy HTTP checks.
assert.doesNotThrow(() => assertMissingAssetCache('no-store'))
for (const policy of [null, undefined, '', 'immutable', 'max-age=31536000', 'public, max-age=31536000, immutable', 'no-store, no-store']) {
  assert.throws(() => assertMissingAssetCache(policy), { code: 'ERR_ASSERTION' })
}

if (process.env.GITHUB_ACTIONS !== 'true') throw Error('Nginx rehearsal is CI-only')
const [repo, artifact, spa, source] = process.argv.slice(2).map(p => path.resolve(p))
const report = process.env.CRM_REPORT_DIR
const release = read(path.join(artifact, 'release.json'))
validateManifest(release)
const proof = JSON.parse(command('image-proof', 'docker', ['image', 'inspect', release.image_id]))[0]
assert.equal(proof.Config.Labels['crm.source-tree'], TREE)
assert.equal(release.source_tree, TREE)
const base = JSON.parse(command('real-compose-model', 'docker', [...composeArgs(repo, path.join(report, 'unused-state')), 'config', '--format', 'json']))
const project = `t004d02_${process.env.GITHUB_RUN_ID}_${process.pid}`
// Operational config contains synthetic credentials: never upload the raw model.
// The private config is outside both upload trees and removed after down.
const mount = (source, target) => ({ type: 'bind', source, target, read_only: true })
// No shared containers/volumes: the API uses this project's disposable DB and Redis.
const privateCompose = privateComposeConfig(source, JSON.stringify({ services: {
  postgres: { image: 'postgres:16-alpine', environment: { POSTGRES_USER: 'wsm', POSTGRES_PASSWORD: 'wsm', POSTGRES_DB: 'wsm' }, tmpfs: ['/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U wsm'], interval: '2s', retries: 30 } },
  redis: { image: 'redis:7-alpine' },
  'crm-api': { image: release.image_id, environment: { ...base.services['crm-api'].environment, WA_GATEWAY: 'fake', AI_MODE: 'fake', CRM_QUEUE_PREFIX: project, CREDENTIALS_KEY: randomBytes(32).toString('base64') }, depends_on: { postgres: { condition: 'service_healthy' }, redis: { condition: 'service_started' } }, healthcheck: base.services['crm-api'].healthcheck },
  'crm-web': { image: base.services['crm-web'].image, command: base.services['crm-web'].command, volumes: [mount(spa, '/usr/share/nginx/html')], ports: ['127.0.0.1::80'] },
  dashboard: { image: 'nginx:1.27-alpine', volumes: [mount(path.join(repo, 'apps/dashboard/nginx.conf'), '/etc/nginx/conf.d/default.conf')], ports: ['127.0.0.1::80'], depends_on: { 'crm-api': { condition: 'service_healthy' }, 'crm-web': { condition: 'service_started' } } },
} }, null, 2))
const file = privateCompose.file
// Compose config preserves $$ in command strings for round-tripping; keep it intact.
const compose = (...args) => command('disposable-nginx-' + args[0], 'docker', ['compose', '-p', project, '-f', file, ...args])
const observations = []
const diagnostic = createDiagnostic({ report, project, composeFile: file })
let browser, page, browserEvents
let primaryError
try {
  diagnostic.start()
  diagnostic.operation('compose_up', () => compose('up', '-d', '--wait', '--wait-timeout', '180'))
  for (const service of ['crm-web', 'dashboard']) diagnostic.operation('nginx_t_' + service, () => compose('exec', '-T', service, 'nginx', '-t'))
  const origin = service => 'http://' + compose('port', service, '80').trim()
  const backend = origin('crm-web'), dashboard = origin('dashboard')
  diagnostic.targets([backend, dashboard])
  diagnostic.snapshot('compose_ready')
  const assets = fs.readdirSync(path.join(spa, 'assets'))
  diagnostic.allowAssets(assets)
  const js = assets.find(n => n.endsWith('.js')), css = assets.find(n => n.endsWith('.css'))
  assert.ok(js && css, 'packaged SPA must have JS and CSS')
  const html = fs.readFileSync(path.join(spa, 'index.html'), 'utf8')
  async function check(url, status, mime, cache) {
    const response = await diagnostic.operation('http_probe', () => fetch(url))
    const body = await response.text(), type = response.headers.get('content-type') ?? '', policy = response.headers.get('cache-control') ?? ''
    observations.push({ url: diagnostic.url(url), status: response.status, type: mimeEvidence(type), cache: ['no-store', 'public, max-age=31536000, immutable'].includes(policy) ? policy : 'other', ...diagnostic.stamp() })
    diagnostic.emit('http', 'response', { url: diagnostic.url(url), status: response.status, mime: mimeEvidence(type) })
    assert.equal(response.status, status, url)
    assert.match(type, mime, url)
    assert.match(policy, cache, url)
    if (status === 404) { assertMissingAssetCache(policy); assert.notEqual(body, html); assert.doesNotMatch(type, /html/); assert.doesNotMatch(policy, /immutable|max-age/); }
    return body
  }
  for (const [host, prefix] of [[backend, ''], [dashboard, '/crm']]) {
    await check(host + prefix + '/assets/missing-t004-d02.js', 404, /text\/plain/, /^no-store$/)
    await check(host + prefix + '/assets/' + js, 200, /javascript/, /^public, max-age=31536000, immutable$/)
    await check(host + prefix + '/assets/' + css, 200, /text\/css/, /^public, max-age=31536000, immutable$/)
    assert.equal(await check(host + prefix + '/flows', 200, /text\/html/, /no-store/), html)
  }
  const api = await diagnostic.operation('api_probe', () => fetch(dashboard + '/crm/api/auth/profile'))
  assert.equal(api.status, 401)
  assert.match(api.headers.get('content-type'), /application\/json/)
  const discovery = await diagnostic.operation('discovery_probe', () => fetch(dashboard + '/crm/.well-known/oauth-authorization-server'))
  assert.equal(discovery.status, 200)
  assert.match(discovery.headers.get('content-type'), /application\/json/)
  assert.ok((await discovery.json()).authorization_endpoint)
  observations.push({ real_api: api.status, real_discovery: discovery.status, ...diagnostic.stamp() })

  // Paint and recover the image-exported SPA through both real Nginx servers.
  const { chromium } = await import(pathToFileURL(path.join(source, 'node_modules/@playwright/test/index.mjs')))
  browser = await diagnostic.operation('chromium_launch', () => chromium.launch({ headless: true }))
  try { diagnostic.browserMetadata(browser, read(path.join(source, 'node_modules/@playwright/test/package.json')).version) } catch { diagnostic.emit('collector', 'unavailable', { reason: 'browser_metadata_unavailable' }) }
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const pageErrors = []
  browserEvents = diagnostic.attach(page, browser, pageErrors)
  let documents = 0
  page.on('request', r => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents++ })
  const company = { id: '11111111-1111-4111-8111-111111111111', name: 'Fixture D02', slug: 'fixture-d02', role: 'member', effective_permissions: ['flows.view', 'dashboard.sales', 'profile.view'] }
  await page.route('**/crm/api/**', route => {
    const url = new URL(route.request().url()).pathname.replace('/crm/api', '')
    const body = url === '/auth/profile' ? { user: { id: '22222222-2222-4222-8222-222222222222', name: 'Fixture', email: 'fixture@example.invalid', locale: 'pt-BR', system_role: 'user', last_company_id: company.id }, companies: [company] }
      : url === '/flows' ? { items: [], folders: [] }
      : url === '/dashboard/bootstrap' ? { products: [], connections: [], filter_groups: [], leads_count: 0 }
      : url === '/dashboard' ? { range: { start_date: '2026-11-21', end_date: '2026-11-21', time_zone: 'America/Sao_Paulo', granularity: 'day' }, previous_range: { start_date: '2026-11-20', end_date: '2026-11-20' }, cached: false, computed_at: '2026-11-21T12:00:00Z' }
      : url === '/companies/' + company.id ? { company: { ...company, time_zone: 'America/Sao_Paulo' } }
      : url === '/app-config' ? { support_widget: { provider: 'none' } }
      : { items: [], page: { page: 1, limit: 20, has_more: false }, total: 0, unread_count: 0, announcements: [] }
    return url.includes('/events') ? route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' }) : route.fulfill({ json: body })
  })
  async function capture(name, testid) {
    const selector = `[data-testid="${testid}"]`
    await diagnostic.operation('wait_' + name, () => waitForVisibleWithEvidence(page, selector, report, name, browserEvents, diagnostic))
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    await page.screenshot({ path: path.join(report, name + '.png') })
    const paint = await page.locator(selector).evaluate(el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el)
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, rect.x + rect.width / 2), Math.min(innerHeight - 1, rect.y + rect.height / 2))
      return { width: rect.width, height: rect.height, display: style.display, visibility: style.visibility, opacity: style.opacity, uncovered: !!hit && (hit === el || el.contains(hit)), shell: !!document.querySelector('[data-testid="shell-sidebar"]') }
    })
    observations.push({ name, paint, documents, ...diagnostic.stamp() })
    assert.ok(paint.width > 0 && paint.height > 0 && paint.uncovered && paint.shell)
    assert.equal(paint.visibility, 'visible'); assert.notEqual(paint.display, 'none'); assert.notEqual(paint.opacity, '0')
  }
  await diagnostic.operation('goto_welcome', () => page.goto(dashboard + '/crm/welcome'))
  await capture('packaged-welcome', 'page-welcome')
  await diagnostic.operation('click_flows', () => page.locator('a[href="/crm/flows"]').first().click())
  await capture('packaged-flows', 'page-flows')
  await diagnostic.operation('goto_direct_flows', () => page.goto(dashboard + '/crm/flows'))
  await capture('packaged-direct-flows', 'page-flows')
  assert.deepEqual(pageErrors, [], 'healthy packaged navigation must not emit pageerror')
  const chunks = assets.filter(n => n.endsWith('.js') && fs.readFileSync(path.join(spa, 'assets', n), 'utf8').includes('page-flows'))
  assert.equal(chunks.length, 1, 'identify the packaged lazy flows module')
  const chunkPattern = '**/crm/assets/' + chunks[0]
  // Break the real lazy module using a real backend 404, without faking its response.
  await page.route(chunkPattern, route => route.continue({ url: dashboard + '/crm/assets/missing-t004-d02.js' }))
  const before = documents
  await diagnostic.operation('goto_missing_flow', () => page.goto(dashboard + '/crm/flows'))
  await capture('packaged-error', 'route-error')
  assert.equal(documents - before, 2, 'one navigation and one automatic reload')
  await diagnostic.operation('click_retry', () => page.getByRole('button', { name: 'Tentar novamente', exact: true }).click())
  await capture('packaged-budget-exhausted', 'route-error')
  assert.equal(documents - before, 2, 'retry must not loop or reload')
  await page.unroute(chunkPattern)
  await diagnostic.operation('click_reload', () => page.getByRole('button', { name: 'Recarregar', exact: true }).click())
  await capture('packaged-recovered', 'page-flows')
  assert.equal(documents - before, 3)
} catch (error) {
  primaryError = error
  if (!hasFailureEvidence(error)) {
    try { await captureBrowserFailure(page, '[before-or-outside-visibility-gate]', report, 'nginx-browser', browserEvents ?? { pageErrors: [], consoleErrors: [], failedRequests: [], failedResponses: [], responses: [] }, error, diagnostic) } catch { /* original error and teardown take precedence */ }
  }
  throw error
} finally {
  await finishBeforeTeardown(diagnostic, [
    () => fs.writeFileSync(path.join(report, 'nginx-http.json'), JSON.stringify(observations, null, 2), { flag: 'wx' }),
    async () => { if (browser) await browser.close() },
    () => fs.writeFileSync(path.join(report, 'nginx-compose.log'), composeLogEvidence(compose('logs', '--no-color', '--timestamps'), diagnostic.url), { flag: 'wx' }),
    () => compose('down', '-v', '--remove-orphans'),
    () => privateCompose.cleanup(), // Only this invocation's private config.
  ], primaryError)
}
