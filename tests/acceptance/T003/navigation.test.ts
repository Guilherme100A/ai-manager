// Build real + Chromium existente, API controlada: não usa banco nem SSO externo.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { importFrom } from '../helpers/app'
import { rootPath } from '../helpers/exec'

const stops = [['home', '#/'], ['sessions', '#/sessions'], ['session-links', '#/session-links'], ['spy', '#/spy']] as const

describe('T003 — navegação limpa composta com T002', () => {
  let browser: any, context: any, page: any, server: any
  let base: string
  let ssoCalls: number
  let pending: Array<() => Promise<void>> = []
  let errors: string[] = []
  let unexpected: string[] = []

  beforeAll(async () => {
    // Reusa o build verificado antes da suíte, sem regenerar dist nem instalar dependências.
    expect(existsSync(rootPath('apps/dashboard/dist/index.html')), 'Execute o build antes da suíte').toBe(true)
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH, 'Use o Chromium existente no cache local').toBeTruthy()
    const vite = await importFrom('apps/dashboard', 'vite')
    server = await vite.preview({ configFile: false, root: rootPath('apps/dashboard'), preview: { host: '127.0.0.1', port: 0 } })
    base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`
    const { chromium } = await importFrom('apps/dashboard', 'playwright')
    browser = await chromium.launch({ headless: true })
  })
  beforeEach(async () => {
    ssoCalls = 0
    pending = []
    errors = []
    unexpected = []
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(() => sessionStorage.setItem('wsm.token', 't003-fixture'))
    page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (e: Error) => errors.push(e.message))
    page.on('console', (m: any) => { if (['warning', 'error'].includes(m.type())) errors.push(m.text()) })
    await context.route('**/*', (route: any) => {
      if (new URL(route.request().url()).origin === base) return route.fallback()
      unexpected.push(route.request().url())
      return route.abort()
    })
    await context.route('**/api/**', async (route: any) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const lists = ['/api/sessions', '/api/session-links', '/api/session-links/runs', '/api/spy/ads', '/api/spy/offers', '/api/spy/probes', '/api/spy/flows']
      if (lists.includes(path)) return route.fulfill({ json: { items: [] } })
      if (path === '/api/auth/me') return route.fulfill({ json: { user: { username: 't003' }, expiresAt: null } })
      if (path === '/api/auth/logout') return route.fulfill({ status: 204 })
      if (path === '/api/spy/auto-probe') return route.fulfill({ json: { excludedSessionIds: [] } })
      if (path === '/api/proxy-sharing') return route.fulfill({ json: { enabled: false, maxSessionsPerIp: 1 } })
      if (path === '/api/reports/message-counts') return route.fulfill({ json: { items: {} } })
      unexpected.push(`${request.method()} ${path}`)
      return route.fulfill({ status: 500, json: { error: { message: 'Unexpected T003 request' } } })
    })
    await context.route('**/metrics', (route: any) => route.fulfill({ body: '', contentType: 'text/plain' }))
    await context.route('**/api/crm/sso', async (route: any) => {
      ssoCalls++
      await new Promise<void>((resolve) => pending.push(async () => {
        await route.fulfill({ json: { token: 't003', url: '/crm/auth/sso?token=t003' } })
        resolve()
      }))
    })
    await context.route('**/crm/auth/sso?*', (route: any) => route.fulfill({ contentType: 'text/html', body: '<title>CRM fixture</title><p>CRM ready</p>' }))
    await page.goto(`${base}/#/`)
    await page.getByTestId('page-home').waitFor()
  })
  afterEach(async () => {
    await Promise.all(pending.splice(0).map((release) => release()))
    await context?.close()
    expect(errors).toEqual([])
    expect(unexpected).toEqual([])
  })
  afterAll(async () => {
    await browser?.close()
    if (server) await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
  })

  // Antes da próxima tarefa (hashchange); aguarda apenas o commit discreto do React.
  async function clickSnapshot(selector: string) {
    return page.evaluate(async (sel: string) => {
      document.querySelector<HTMLAnchorElement>(sel)!.click()
      await Promise.resolve()
      return {
        hash: location.hash,
        roots: Array.from(document.querySelectorAll('[data-testid^="page-"]'), (e) => e.getAttribute('data-testid')),
        active: Array.from(document.querySelectorAll('[aria-current="page"]'), (e) => e.getAttribute('data-testid')),
      }
    }, selector)
  }

  it('brand e nav trocam URL, uma raiz e aria-current no gesto, inclusive em navegação rápida', async () => {
    for (const [name, hash] of [...stops.slice(1), ...stops, ...stops]) {
      expect(await page.getByTestId(`nav-${name}`).getAttribute('href')).toBe(hash)
      expect(await clickSnapshot(`[data-testid="nav-${name}"]`)).toEqual({ hash, roots: [`page-${name}`], active: [`nav-${name}`] })
    }
    expect(await page.locator('.brand').getAttribute('href')).toBe('#/')
    expect(await clickSnapshot('.brand')).toEqual({ hash: '#/', roots: ['page-home'], active: ['nav-home'] })
    expect(ssoCalls).toBe(0)
  })

  it.each(['pointer', 'keyboard'])('troca a raiz antes do próximo frame no gesto real: %s', async (gesture) => {
    await page.evaluate(() => {
      ;(window as any).__t003Gesture = new Promise<unknown[]>((resolve) => {
        document.addEventListener('click', () => {
          const samples: unknown[] = []
          function sample() {
            samples.push({
              hash: location.hash,
              roots: Array.from(document.querySelectorAll('[data-testid^="page-"]'), (e) => e.getAttribute('data-testid')),
              active: Array.from(document.querySelectorAll('[aria-current="page"]'), (e) => e.getAttribute('data-testid')),
            })
            if (samples.length === 6) resolve(samples)
            else requestAnimationFrame(sample)
          }
          queueMicrotask(sample)
        }, { once: true })
      })
    })
    const link = page.getByTestId('nav-sessions')
    if (gesture === 'pointer') await link.click()
    else { await link.focus(); await page.keyboard.press('Enter') }
    expect(await page.evaluate(() => (window as any).__t003Gesture)).toEqual(Array.from({ length: 6 }, () => ({
      hash: '#/sessions', roots: ['page-sessions'], active: ['nav-sessions'],
    })))
  })

  it('preserva back/forward, hash externo, foco e ativação por Enter', async () => {
    const link = page.getByTestId('nav-sessions')
    await link.focus()
    await page.keyboard.press('Enter')
    await page.getByTestId('page-sessions').waitFor()
    expect(await link.evaluate((e: Element) => document.activeElement === e)).toBe(true)
    expect(await link.getAttribute('aria-current')).toBe('page')
    expect(await link.evaluate((e: Element) => {
      const s = getComputedStyle(e)
      return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none'
    })).toBe(true)
    await page.getByTestId('nav-session-links').click()
    await page.getByTestId('page-session-links').waitFor()
    for (const [direction, name] of [['goBack', 'sessions'], ['goBack', 'home'], ['goForward', 'sessions'], ['goForward', 'session-links']]) {
      await page[direction]()
      await page.getByTestId(`page-${name}`).waitFor()
      expect(await page.locator('[data-testid^="page-"]').count()).toBe(1)
      expect(await page.locator('[aria-current="page"]').count()).toBe(1)
      expect(await page.getByTestId(`nav-${name}`).getAttribute('aria-current')).toBe('page')
    }
    await page.evaluate(() => { location.hash = '#/spy' })
    await page.getByTestId('page-spy').waitFor()
    expect(await page.getByTestId('nav-spy').getAttribute('aria-current')).toBe('page')
    expect(ssoCalls).toBe(0)
  })

  it('menu móvel fecha e foca na navegação interna; Escape e skip-link continuam locais', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    const menu = page.getByTestId('nav-toggle')
    await menu.click()
    await page.getByTestId('nav-sessions').click()
    await page.getByTestId('page-sessions').waitFor()
    expect(await menu.getAttribute('aria-expanded')).toBe('false')
    expect(await page.locator('main').evaluate((e: Element) => document.activeElement === e)).toBe(true)
    await menu.click()
    await page.locator('.brand').click()
    await page.getByTestId('page-home').waitFor()
    expect(await menu.getAttribute('aria-expanded')).toBe('false')
    expect(await page.locator('main').evaluate((e: Element) => document.activeElement === e)).toBe(true)
    await menu.click()
    await page.keyboard.press('Escape')
    expect(await menu.getAttribute('aria-expanded')).toBe('false')
    expect(await menu.evaluate((e: Element) => document.activeElement === e)).toBe(true)
    const original = page.url()
    await page.locator('.skip-link').focus()
    await page.keyboard.press('Enter')
    expect(page.url()).toBe(original)
    expect(await page.locator('main').evaluate((e: Element) => document.activeElement === e)).toBe(true)
  })

  it('mantém href, modificadores, foco, menu e nova aba no brand e nav', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('nav-toggle').click()
    for (const selector of ['[data-testid="nav-sessions"]', '.brand']) {
      const link = page.locator(selector)
      await link.focus()
      const original = page.url()
      const destination = await link.getAttribute('href')
      for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey', 'middle', 'target', 'download', 'prevented']) {
        const intercepted = await link.evaluate((el: HTMLAnchorElement, key: string) => {
          if (key === 'target') el.target = '_blank'
          if (key === 'download') el.download = 't003'
          let prevented = false
          const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: key === 'middle' ? 1 : 0, [key]: true })
          if (key === 'prevented') event.preventDefault()
          // Observa depois do React e bloqueia a ação nativa somente no harness.
          document.addEventListener('click', (e) => { prevented = e.defaultPrevented; e.preventDefault() }, { once: true })
          el.dispatchEvent(event)
          el.removeAttribute('target')
          el.removeAttribute('download')
          return prevented
        }, modifier)
        expect(intercepted, modifier).toBe(modifier === 'prevented')
        expect(page.url()).toBe(original)
        expect(await page.getByTestId('nav-toggle').getAttribute('aria-expanded')).toBe('true')
        expect(await link.evaluate((el: Element) => document.activeElement === el)).toBe(true)
      }
      const popupPromise = context.waitForEvent('page')
      await link.click({ modifiers: ['ControlOrMeta'] })
      const popup = await popupPromise
      await popup.waitForLoadState('domcontentloaded')
      expect(new URL(popup.url()).hash).toBe(destination)
      expect(page.url()).toBe(original)
      expect(await page.getByTestId('nav-toggle').getAttribute('aria-expanded')).toBe('true')
      await popup.close()
    }
    expect(ssoCalls).toBe(0)
  })

  it('logout abre login e limpa o token local', async () => {
    await page.getByTestId('nav-logout').click()
    await page.getByTestId('login-username').waitFor()
    expect(new URL(page.url()).hash).toBe('#/login')
    expect(await page.locator('.login').count()).toBe(1)
    expect(await page.locator('[data-testid^="page-"]').count()).toBe(0)
    expect(await page.evaluate(() => sessionStorage.getItem('wsm.token'))).toBeNull()
  })

  it('CRM primário substitui a página na mesma aba com destino controlado', async () => {
    await page.getByTestId('nav-crm').click()
    await page.getByTestId('crm-loading').waitFor()
    await expect.poll(() => ssoCalls).toBe(1)
    await Promise.all(pending.splice(0).map((release) => release()))
    await page.waitForURL((url: URL) => url.origin === base && url.pathname === '/crm/auth/sso' && url.searchParams.get('token') === 't003' && url.searchParams.has('crm_entry'))
    expect(await page.title()).toBe('CRM fixture')
    expect(page.frames()).toHaveLength(1)
    expect(context.pages()).toHaveLength(1)
    await page.goBack()
    await page.getByTestId('page-home').waitFor()
    expect(ssoCalls).toBe(1)
  })
})
