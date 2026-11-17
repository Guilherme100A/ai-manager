/* eslint-disable @typescript-eslint/no-explicit-any -- Playwright harness */
import { describe, expect, it } from 'vitest'
import { ADMIN_PASSWORD, ADMIN_USERNAME, doLogin, go, hashOf, tid, useDashboard } from './shared'

const key = 'wsm.remembered-session'
describe('dashboard remembered login', () => {
  const ctx = useDashboard()
  async function signIn(page: any, remember: boolean) {
    await go(ctx, page, '/login')
    await page.getByTestId('login-username').fill(ADMIN_USERNAME)
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD)
    await page.getByTestId('login-remember').setChecked(remember)
    await page.getByTestId('login-submit').click()
    await page.getByTestId('nav-logout').waitFor()
  }
  it('unchecked stays session-only and reopening requires login', async () => {
    const page = await ctx.newPage({ login: false })
    await go(ctx, page, '/login')
    expect(await page.getByTestId('login-remember').isChecked()).toBe(false)
    await doLogin(ctx, page)
    expect(await page.evaluate((k: string) => localStorage.getItem(k) === null, key)).toBe(true)
    const state = await page.context().storageState()
    await page.context().close()
    const reopened = await ctx.browser.newContext({ storageState: state })
    try {
      const next = await reopened.newPage(); await go(ctx, next, '/sessions')
      await next.getByTestId('login-username').waitFor()
    } finally { await reopened.close() }
  })
  it('checked survives a new browser context, never stores password, and has a 30-day server expiry', async () => {
    const page = await ctx.newPage({ login: false })
    await page.setViewportSize({ width: 390, height: 844 })
    await signIn(page, true)
    const storage = await page.evaluate(({ k, password }: { k: string; password: string }) => {
      const value = JSON.parse(localStorage.getItem(k)! )
      return { keys: Object.keys(value).sort(), lifetime: Date.parse(value.expiresAt) - Date.now(), leakedPassword: JSON.stringify({ ...localStorage }).includes(password) }
    }, { k: key, password: ADMIN_PASSWORD })
    expect(storage.keys).toEqual(['expiresAt', 'token'])
    expect(storage.lifetime).toBeGreaterThan(29 * 86400000)
    expect(storage.lifetime).toBeLessThanOrEqual(30 * 86400000)
    expect(storage.leakedPassword).toBe(false)
    const state = await page.context().storageState(); await page.context().close()
    const reopened = await ctx.browser.newContext({ storageState: state })
    try {
      const next = await reopened.newPage(); await go(ctx, next, '/sessions')
      await next.locator(tid('add-session')).waitFor()
      expect(await hashOf(next)).toBe('#/sessions')
      expect(await next.evaluate(() => !!sessionStorage.getItem('wsm.token'))).toBe(true)
    } finally { await reopened.close() }
  })
  it('revoked login is rejected and persistent storage is removed', async () => {
    const page = await ctx.newPage({ login: false }); await signIn(page, true)
    const status = await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + sessionStorage.getItem('wsm.token') } })).status)
    expect(status).toBe(204)
    await page.reload()
    await page.getByTestId('login-username').waitFor()
    expect(await page.evaluate((k: string) => localStorage.getItem(k) === null && sessionStorage.getItem('wsm.token') === null, key)).toBe(true)
  })
  it('three remembered sessions of the same account remain independent after one signs out', async () => {
    const pages = await Promise.all(Array.from({ length: 3 }, () => ctx.newPage({ login: false })))
    for (const page of pages) await signIn(page, true)
    await pages[0].getByTestId('nav-logout').click()
    await pages[0].getByTestId('login-username').waitFor()
    for (const page of pages.slice(1)) {
      await page.reload(); await page.getByTestId('nav-logout').waitFor()
      expect(await page.evaluate(async () => (await fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + sessionStorage.getItem('wsm.token') } })).status)).toBe(200)
    }
  })
  it('expired local storage and invalid credentials cannot restore or save a login', async () => {
    const page = await ctx.newPage({ login: false })
    await page.addInitScript((k: string) => localStorage.setItem(k, JSON.stringify({ token: 'expired-synthetic-token', expiresAt: '2000-01-01T00:00:00Z' })), key)
    await go(ctx, page, '/sessions'); await page.getByTestId('login-username').waitFor()
    expect(await page.evaluate((k: string) => localStorage.getItem(k) === null, key)).toBe(true)
    await page.getByTestId('login-username').fill(ADMIN_USERNAME)
    await page.getByTestId('login-password').fill('wrong-synthetic-password')
    await page.getByTestId('login-remember').check()
    await page.getByTestId('login-submit').click(); await page.getByTestId('login-error').waitFor()
    expect(await page.evaluate((k: string) => localStorage.getItem(k) === null, key)).toBe(true)
  })
})
