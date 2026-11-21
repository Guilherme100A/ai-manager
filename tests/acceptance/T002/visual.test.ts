// Browser e build reais; API simulada explicitamente. Não substitui o harness integrado.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

const root = process.cwd()
const { chromium } = createRequire(resolve(root, 'apps/dashboard/package.json'))('playwright')
const artifacts = resolve(root, 'test-results/T002')
const dist = resolve(root, 'apps/dashboard/dist')
// Reusa somente a medição WCAG do T21, sem carregar seus hooks Postgres/Redis.
const colorLib = readFileSync(resolve(root, 'tests/acceptance/T21/shared.ts'), 'utf8').match(/export const COLOR_LIB = `([\s\S]*?)`/)![1]
let browser: any
let origin: string
const assets = new Map<string, Buffer>()
const server = createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return }
  const path = resolve(dist, `.${new URL(req.url!, 'http://localhost').pathname}`)
  if (path !== dist && !path.startsWith(dist + sep)) { res.writeHead(403); res.end(); return }
  const file = path === dist ? resolve(dist, 'index.html') : path
  if (!assets.has(file)) { res.writeHead(404); res.end(); return }
  res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
  res.end(assets.get(file))
})
beforeAll(async () => {
  expect(process.env.PLAYWRIGHT_BROWSERS_PATH, 'Use o browser local, sem instalar dependências').toBeTruthy()
  mkdirSync(artifacts, { recursive: true })
  // Snapshot em memória: outro harness pode regenerar dist durante os testes.
  for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = resolve(entry.parentPath, entry.name)
      assets.set(file, readFileSync(file))
    }
  }
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  await browser?.close()
  await new Promise<void>((done) => server.close(() => done()))
})

async function fixture(width = 1440, theme = 'dark') {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors: string[] = [], external: string[] = []
  const calls: Array<{ path: string; method: string; body: any }> = []
  const now = '2026-11-21T12:00:00.000Z'
  let sessions = ['STABLE', 'NEW', 'PAUSED', 'DISCONNECTED', 'WARMING', 'DEGRADED'].map((status, i) => ({
    id: `qa-${i}`, name: `QA · Chip ${i + 1}`, phone: `+551199990000${i}`, status, state: status,
    proxyId: null, proxy: null, note: 'Dados simulados para revisão visual T002', requiresRestart: false,
    warmupStartedAt: null, lastConnectedAt: i === 1 ? null : now, createdAt: now, updatedAt: now,
  }))
  let links: any[] = [{ id: 'qa-link', sourceSessionId: 'qa-0', targetSessionId: 'qa-1', enabled: false, rules: { matchText: 'oi', replyText: 'Olá! Como podemos ajudar?' } }]
  const state = { delay: 0, failLinks: false, empty: false }
  page.on('pageerror', (error: Error) => errors.push(error.message))
  page.on('console', (message: any) => { if (message.type() === 'error' && !(state.failLinks && message.text().includes('503'))) errors.push(`${message.text()} ${message.location().url}`) })
  page.on('request', (request: any) => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) external.push(request.url()) })
  await page.addInitScript(() => sessionStorage.setItem('wsm.token', 't002-fixture-token'))
  await page.addInitScript(colorLib)
  await page.route('**/api/**', async (route: any) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
    const body = request.postData() ? JSON.parse(request.postData()) : undefined
    calls.push({ path, method, body })
    if (state.delay) await new Promise((done) => setTimeout(done, state.delay))
    let result: unknown
    if (path === '/api/auth/me') result = { user: { username: 'QA', role: 'admin' }, expiresAt: null }
    else if (path === '/api/sessions') {
      if (method === 'POST') {
        const created = { ...sessions[1], ...body, id: 'qa-created', status: 'NEW', state: 'NEW' }
        sessions.push(created); result = created
      } else result = { items: state.empty ? [] : sessions }
    } else if (path === '/api/proxy-sharing') result = { enabled: true, maxSessionsPerIp: 2 }
    else if (path === '/api/reports/message-counts') result = { items: Object.fromEntries(sessions.map((s, i) => [s.id, { sentTotal: i * 10, receivedTotal: i * 6, sent24h: i * 2, received24h: i }])) }
    else if (path === '/api/session-links/runs') result = { items: [] }
    else if (path === '/api/session-links') {
      if (state.failLinks) { await route.fulfill({ status: 503, json: { error: { code: 'QA_UNAVAILABLE', message: 'Falha simulada: tente novamente.' } } }); return }
      if (method === 'POST') { const link = { id: `qa-link-${links.length}`, ...body, enabled: false }; links.push(link); result = link }
      else result = { items: state.empty ? [] : links }
    } else if (path.startsWith('/api/session-links/')) {
      const id = path.split('/').pop()
      if (method === 'DELETE') { links = links.filter((l) => l.id !== id); await route.fulfill({ status: 204 }); return }
      const link = links.find((l) => l.id === id); Object.assign(link, body); result = link
    } else if (path === '/api/ai/settings') result = { enabled: false, hasApiKey: false }
    else if (path === '/api/messages') result = { items: [] }
    else if (path.endsWith('/conversation')) result = {
      config: { mode: 'rotating', enabled: false, targetSessionId: null, topic: 'QA', maxMessagesPerDay: 20, turnsPerConversation: 2, intervalMinutes: 5 },
      activePartnerId: null, state: { turns: 0, pending: null }, accounts: [],
    }
    else if (path.endsWith('/health')) result = { state: 'STABLE', warmupPercent: 80, score: 95, label: 'Good', sent: 0, received: 0, failed: 0, disconnects: 0, forbidden403: 0, lastEventAt: now }
    else if (path.endsWith('/chats')) result = { items: [{ phone: '5511999900100', name: 'Contato QA', isSession: false, sent: 1, received: 1, lastAt: now, lastText: 'Olá', lastDirection: 'inbound' }] }
    else if (path.includes('/chats/')) result = { items: [] }
    else if (path.endsWith('/pairing-code')) result = { code: '1234-5678' }
    else if (path.startsWith('/api/sessions/')) {
      const id = path.split('/')[3], session = sessions.find((s) => s.id === id)!
      if (path.endsWith('/qr') && method === 'GET') {
        // Teste de dimensão, não é um QR utilizável.
        result = { qr: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="264" height="264"><rect width="264" height="264" fill="white"/><text x="35" y="132" fill="black">QR simulado · T002</text></svg>'), generatedAt: now }
      } else if (method === 'DELETE') { sessions = sessions.filter((s) => s.id !== id); await route.fulfill({ status: 204 }); return }
      else { if (path.endsWith('/pause')) session.status = 'PAUSED'; result = session }
    } else { errors.push(`API inesperada: ${method} ${path}`); await route.abort(); return }
    await route.fulfill({ json: result })
  })
  await page.route('**/metrics', (route: any) => route.fulfill({ body: '', contentType: 'text/plain' }))
  async function go(hash: string) {
    await page.goto(`${origin}/#${hash}`)
    await page.locator('.chip-workspace').waitFor()
    await page.waitForLoadState('networkidle')
  }
  async function clean() {
    await context.close()
    expect(external, 'nenhuma requisição externa').toEqual([])
    expect(errors, 'nenhum erro inesperado de console/página/API').toEqual([])
  }
  return { page, go, clean, calls, state }
}

async function checkLayout(page: any) {
  expect(await page.locator('[aria-current]').count()).toBe(1)
  expect(await page.locator('[aria-current="page"]').count()).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.locator('.main').evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth)).toBe(true)
  expect(await page.evaluate(() => (window as any).__wsmColor.lowContrast(document.querySelector('.layout')))).toEqual([])
  const small = await page.locator('.chip-workspace button, .chip-workspace a, .chip-workspace select, .chip-workspace input, .sidebar button, .nav a').evaluateAll((elements: HTMLElement[]) => elements.flatMap((el) => {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el = el.closest('label') ?? el
    const r = el.getBoundingClientRect()
    return r.width && r.height && (r.height < 44 || r.width < 44) ? [{ text: el.textContent, width: r.width, height: r.height }] : []
  }))
  expect(small, 'alvos de 44px').toEqual([])
}

describe('T002 — núcleo WhatsApp com fixtures explícitas', () => {
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) {
    it(`${theme} ${width}: quatro rotas, contraste, alvos, menu, tema e capturas`, async () => {
      const f = await fixture(width, theme)
      try {
        for (const [name, hash] of [['sessions', '/sessions'], ['new-session', '/sessions/new'], ['session', '/sessions/qa-0'], ['session-links', '/session-links']]) {
          await f.go(hash)
          await checkLayout(f.page)
          if (theme === 'dark') await f.page.screenshot({ path: resolve(artifacts, `${name}-dark-${width}.png`), fullPage: true })
        }
        if (width === 390) {
          const menu = f.page.getByTestId('nav-toggle')
          await menu.click()
          expect(await menu.getAttribute('aria-expanded')).toBe('true')
          await f.page.keyboard.press('Escape')
          expect(await menu.getAttribute('aria-expanded')).toBe('false')
          expect(await menu.evaluate((el: Element) => document.activeElement === el)).toBe(true)
          await menu.click(); await f.page.getByTestId('nav-session-links').click()
          expect(await menu.getAttribute('aria-expanded')).toBe('false')
          await menu.click(); await f.page.getByTestId('nav-sessions').click()
          expect(await menu.getAttribute('aria-expanded')).toBe('false')
          expect(await f.page.locator('.main').evaluate((el: Element) => document.activeElement === el)).toBe(true)
        }
        await f.page.getByTestId('theme-toggle').click(); await f.page.reload()
        expect(await f.page.locator('html').getAttribute('data-theme')).toBe(theme === 'dark' ? 'light' : 'dark')
        expect(await f.page.evaluate(() => Object.keys(localStorage))).toEqual(['wsm.theme'])
        await f.page.keyboard.press('Tab')
        expect(await f.page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe('none')
      } finally { await f.clean() }
    })
  }
  it('vínculos: A diferente de B, operação única, loading, sucesso, destrutivo, vazio e erro', async () => {
    const f = await fixture(390)
    try {
      await f.go('/session-links')
      const source = f.page.getByLabel('Sessão que recebe (A)'), target = f.page.getByLabel('Sessão que envia a resposta (B)')
      await source.selectOption('qa-0'); await target.selectOption('qa-1'); await source.selectOption('qa-1')
      expect(await target.inputValue()).toBe('')
      expect(await target.locator('option[value="qa-1"]').count()).toBe(0)
      await target.selectOption('qa-0')
      await f.page.getByLabel('Mensagem recebida', { exact: false }).fill('teste')
      await f.page.getByLabel('Resposta enviada por B').fill('Resposta QA')
      f.state.delay = 500
      await f.page.getByRole('button', { name: 'Criar vínculo desativado' }).click()
      expect(await source.isDisabled()).toBe(true)
      expect(await f.page.getByRole('button', { name: 'Ativar envio automático' }).first().isDisabled()).toBe(true)
      await f.page.getByText('Processando vínculo…').waitFor()
      await f.page.getByText('Vínculo criado desativado.').waitFor()
      expect(f.calls.filter((c) => c.path === '/api/session-links' && c.method === 'POST')).toHaveLength(1)
      f.state.delay = 0
      await f.page.getByRole('button', { name: 'Ativar envio automático' }).first().click()
      await f.page.getByText('Envio automático ativado.').waitFor()
      await f.page.getByText('Desative antes de excluir.').waitFor()
      expect(await f.page.getByRole('button', { name: 'Excluir', exact: true }).first().isDisabled()).toBe(true)
      await f.page.getByRole('button', { name: 'Desativar', exact: true }).first().click()
      await f.page.getByText('Vínculo desativado.').waitFor()
      await f.page.getByRole('button', { name: 'Excluir', exact: true }).first().click()
      await f.page.getByText('Vínculo excluído.').waitFor()
      f.state.empty = true; f.state.delay = 500
      await f.page.reload(); await f.page.getByText('Carregando vínculos…').waitFor()
      await f.page.getByText('Nenhum vínculo cadastrado.').waitFor(); await f.page.getByText('Nenhuma execução.').waitFor()
      f.state.failLinks = true; f.state.delay = 0
      await f.go('/session-links'); await f.page.getByRole('alert').filter({ hasText: 'Falha simulada' }).waitFor()
    } finally { await f.clean() }
  })
  it('cadastro e detalhe: QR responsivo, proxy, pairing, ações e seleção de conversa', async () => {
    const f = await fixture(390)
    try {
      await f.go('/sessions/new')
      await f.page.getByTestId('new-name').fill('Chip QA criado')
      await f.page.getByTestId('new-direct-connection').uncheck(); await f.page.getByTestId('gen-qr').click()
      await f.page.getByTestId('new-proxy-error').waitFor()
      expect(f.calls.filter((c) => c.path === '/api/sessions' && c.method === 'POST')).toHaveLength(0)
      await f.page.getByTestId('new-direct-connection').check(); await f.page.getByTestId('gen-pairing').click()
      await f.page.getByTestId('auth-error').waitFor(); await f.page.getByTestId('gen-qr').click()
      await f.page.getByTestId('qr-image').waitFor(); await checkLayout(f.page)
      await f.page.screenshot({ path: resolve(artifacts, 'qr-dark-390.png'), fullPage: true })
      await f.go('/sessions/qa-1'); await f.page.getByTestId('session-gen-qr').click()
      await f.page.getByTestId('qr-image').waitFor(); await checkLayout(f.page)
      await f.go('/sessions/qa-0'); await f.page.getByTestId('btn-pause').click()
      await f.page.getByTestId('btn-resume').waitFor()
      await f.page.getByRole('button', { name: 'Ver conversas', exact: true }).click()
      await f.page.getByRole('button', { name: /Contato QA/ }).click()
      expect(await f.page.locator('[aria-current]').count()).toBe(1)
      expect(await f.page.getByRole('button', { name: /Contato QA/ }).getAttribute('aria-pressed')).toBe('true')
    } finally { await f.clean() }
  })
})
