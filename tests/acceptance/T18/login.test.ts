// AC-T18-01 — login com Usuário e Senha via POST /api/auth/login; token em memória/sessionStorage (nunca localStorage);
// erro de credencial na tela; sem token ou com 401 volta ao login; "Sair" chama /api/auth/logout.
import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { ADMIN_PASSWORD, ADMIN_USERNAME, doLogin, go, hashOf, recordApiRequests, tid, useDashboard } from './shared'

const storedToken = (page: any) => page.evaluate(() => sessionStorage.getItem('wsm.token'))

describe('T18 — login de administrador', () => {
  const ctx = useDashboard()

  it('AC-T18-01 a tela de login tem Usuário e Senha (sem campo de API token)', async () => {
    const page = await ctx.newPage({ login: false })
    await go(ctx, page, '/login')
    await page.locator(tid('login-username')).waitFor({ state: 'visible' })
    await page.locator(tid('login-password')).waitFor({ state: 'visible' })
    await page.getByRole('heading', { name: 'Bem-vindo de volta' }).waitFor()
    expect(await page.locator(tid('login-password')).getAttribute('type')).toBe('password')
    for (const label of ['Usuário', 'Senha']) expect(await page.getByText(label, { exact: true }).count(), `rótulo ${label}`).toBeGreaterThan(0)
    expect(await page.locator(tid('login-token')).count(), 'campo antigo de API token').toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  })

  it('AC-T18-01 login admin/nimda chama POST /api/auth/login e guarda o token só em memória/sessionStorage', async () => {
    const page = await ctx.newPage({ login: false })
    const seen = recordApiRequests(page)
    await doLogin(ctx, page)

    const login = seen.find((r) => r.method === 'POST' && r.path === '/api/auth/login')
    expect(login, 'POST /api/auth/login não foi chamado').toBeTruthy()
    expect(login!.body).toMatchObject({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })

    const token = await storedToken(page)
    expect(token, 'token em sessionStorage wsm.token').toBeTruthy()
    expect(token, 'o painel não deve usar o API_TOKEN').not.toBe(ctx.token)
    const me = await call(ctx.app, 'GET', '/api/auth/me', { token })
    expect(me.status, me.text).toBe(200)
    expect(me.body?.username ?? me.body?.user?.username).toBe(ADMIN_USERNAME)

    const leaks = await page.evaluate(() => ({
      local: JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))),
      cookie: document.cookie,
    }))
    expect(leaks.local, 'token no localStorage').not.toContain(token)
    expect(leaks.cookie, 'token em cookie').not.toContain(token)

    // chamadas seguintes usam o token de login
    await go(ctx, page, '/sessions')
    await page.locator(tid('add-session')).waitFor({ state: 'visible' })
    const authed = seen.filter((r) => r.path.startsWith('/api/sessions'))
    expect(authed.length).toBeGreaterThan(0)
    expect(authed.every((r) => r.authorization === `Bearer ${token}`)).toBe(true)
  })

  it('AC-T18-01 credencial errada mostra o erro na tela e não guarda token', async () => {
    const page = await ctx.newPage({ login: false })
    await go(ctx, page, '/login')
    await page.locator(tid('login-username')).fill(ADMIN_USERNAME)
    await page.locator(tid('login-password')).fill('senha-errada')
    await page.locator(tid('login-submit')).click()
    const err = page.locator(tid('login-error'))
    await err.waitFor({ state: 'visible' })
    expect(((await err.textContent()) ?? '').trim().length).toBeGreaterThan(0)
    expect(await hashOf(page)).toMatch(/^#\/login/)
    const t = await storedToken(page)
    expect(t === null || t === '').toBe(true)
  })

  it('opens the CRM as the main page and keeps the validated Meta destination', async () => {
    const page = await ctx.newPage({ login: false })
    const area = '11111111-2222-4333-8444-555555555555'
    await page.route('**/api/crm/sso', (route) => route.fulfill({ json: { url: '/crm/auth/sso#token=fixture' } }))
    await page.route('**/crm/auth/sso?*', (route) => route.fulfill({ contentType: 'text/html', body: '<p>CRM fixture</p>' }))
    await page.goto(ctx.base + '/?meta_oauth=success&meta_workspace=' + area + '#/crm')
    await page.locator(tid('login-username')).fill(ADMIN_USERNAME)
    await page.locator(tid('login-password')).fill(ADMIN_PASSWORD)
    await page.locator(tid('login-submit')).click()
    await page.getByText('CRM fixture').waitFor()
    const url = new URL(page.url())
    expect(url.pathname).toBe('/crm/auth/sso')
    expect(await page.locator(tid('crm-frame')).count()).toBe(0)
    const fragment = new URLSearchParams(url.hash.slice(1))
    expect(fragment.get('redirect')).toBe('/facebook/profiles?meta_oauth=success&meta_workspace=' + area)
    expect(url.searchParams.has('token')).toBe(false)
  })

  it('normal login opens the CRM in the same tab without an iframe', async () => {
    const page = await ctx.newPage({ login: false })
    await page.route('**/api/crm/sso', (route) => route.fulfill({ json: { url: '/crm/auth/sso#token=fixture' } }))
    await page.route('**/crm/auth/sso?*', (route) => route.fulfill({ contentType: 'text/html', body: '<p>CRM principal</p>' }))
    await page.goto(ctx.base + '/#/login')
    await page.locator(tid('login-username')).fill(ADMIN_USERNAME)
    await page.locator(tid('login-password')).fill(ADMIN_PASSWORD)
    await page.locator(tid('login-submit')).click()
    await page.getByText('CRM principal').waitFor()
    expect(new URL(page.url()).pathname).toBe('/crm/auth/sso')
    expect(await page.locator(tid('crm-frame')).count()).toBe(0)
  })

  it('AC-T18-01 sem token, as rotas voltam ao login', async () => {
    const page = await ctx.newPage({ login: false })
    for (const route of ['/', '/sessions', '/sessions/new', '/contacts']) {
      await go(ctx, page, route)
      await expect.poll(() => hashOf(page), { timeout: 10_000, message: `rota ${route} sem token` }).toMatch(/^#\/login/)
    }
  })

  it('AC-T18-01 token revogado (401) volta ao login e limpa o token', async () => {
    const page = await ctx.newPage()
    const token = await storedToken(page)
    const out = await call(ctx.app, 'POST', '/api/auth/logout', { token })
    expect([200, 204]).toContain(out.status)
    await go(ctx, page, '/sessions')
    await expect.poll(() => hashOf(page), { timeout: 15_000, message: '401 deveria voltar ao login' }).toMatch(/^#\/login/)
    await expect.poll(() => storedToken(page), { timeout: 5_000 }).toBeNull()
  })

  it('AC-T18-01 "Sair" chama POST /api/auth/logout, revoga o token e volta ao login', async () => {
    const page = await ctx.newPage()
    const seen = recordApiRequests(page)
    const token = await storedToken(page)
    await page.locator(tid('nav-logout')).click()
    await expect.poll(() => hashOf(page), { timeout: 10_000 }).toMatch(/^#\/login/)
    const logout = seen.find((r) => r.method === 'POST' && r.path === '/api/auth/logout')
    expect(logout, 'POST /api/auth/logout não foi chamado').toBeTruthy()
    expect(logout!.authorization).toBe(`Bearer ${token}`)
    expect(await storedToken(page)).toBeNull()
    await expect.poll(async () => (await call(ctx.app, 'GET', '/api/auth/me', { token })).status, { timeout: 5_000 }).toBe(401)
  })
})
