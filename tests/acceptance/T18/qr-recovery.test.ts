import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { api, createSession, findSessionByName, go, recordApiRequests, setStatus, tid, useDashboard } from './shared'

describe('QR: recuperação e layout mobile', () => {
  const ctx = useDashboard()

  for (const width of [390, 1440]) {
    it(`reconecta a sessão existente pelo detalhe em ${width}px, sem duplicar o cadastro`, async () => {
      const s = await createSession(ctx)
      setStatus(ctx, s.id, 'DISCONNECTED')
      const page = await ctx.newPage()
      await page.setViewportSize({ width, height: 900 })
      await go(ctx, page, '/sessions')
      await page.locator(`${tid('session-row')}[data-session-id="${s.id}"] ${tid('session-link')}`).click()
      const seen = recordApiRequests(page)
      await page.locator(tid('session-gen-qr')).click()
      await expect.poll(() => ctx.tf.connectCount(s.id)).toBe(1)
      ctx.tf.last(s.id)!.emitQr('test-session-qr')
      const img = page.locator(tid('qr-image'))
      await img.waitFor({ state: 'visible' })
      expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth > 0)).toBe(true)
      const box = await img.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      expect(seen.filter((r) => r.method === 'POST' && r.path === '/api/sessions')).toEqual([])
      await ctx.tf.last(s.id)!.login()
      await ctx.manager.whenIdle()
      expect((await api(ctx, 'GET', `/api/sessions/${s.id}`)).body.status).toBe('WARMING')
      await page.locator(tid('session-qr-panel')).waitFor({ state: 'detached' })
    })
  }

  it('cadastro mobile descarta QR nulo/erro, recupera e tenta novamente na mesma sessão', async () => {
    const page = await ctx.newPage()
    await page.setViewportSize({ width: 390, height: 844 })
    await go(ctx, page, '/sessions')
    await page.locator(tid('add-session')).click()
    const name = `qr-recovery-${randomBytes(4).toString('hex')}`
    await page.locator(tid('new-name')).fill(name)
    const seen = recordApiRequests(page)
    await page.locator(tid('gen-qr')).click()
    const id = await findSessionByName(ctx, name)
    await expect.poll(() => ctx.tf.connectCount(id)).toBe(1)
    ctx.tf.last(id)!.emitQr('test-initial-qr')
    const img = page.locator(tid('qr-image'))
    await img.waitFor({ state: 'visible' })
    let mode = 'null'
    await page.route(`**/api/sessions/${id}/qr`, async (route: any) => {
      if (route.request().method() !== 'GET' || mode === 'ok') return route.continue()
      return route.fulfill({ status: mode === 'error' ? 503 : 200, json: mode === 'error' ? { error: { code: 'SERVICE_UNAVAILABLE', message: 'Conexão indisponível' } } : { qr: null, generatedAt: null } })
    })
    await img.waitFor({ state: 'detached' })
    mode = 'error'
    await page.locator(tid('auth-error')).waitFor({ state: 'visible' })
    expect(await img.count()).toBe(0)
    mode = 'ok'
    ctx.tf.last(id)!.emitQr('test-updated-qr')
    await img.waitFor({ state: 'visible' })
    await page.locator(tid('auth-error')).waitFor({ state: 'detached' })
    await ctx.manager.logout(id)
    await img.waitFor({ state: 'detached' })
    await page.locator(tid('auth-error')).waitFor({ state: 'visible' })
    await page.locator(tid('gen-qr')).click()
    await expect.poll(async () => (await page.locator(tid('auth-error')).count()) ? page.locator(tid('auth-error')).innerText() : '', { timeout: 10000 }).toBe('')
    await expect.poll(() => ctx.tf.connectCount(id)).toBe(2)
    ctx.tf.last(id)!.emitQr('test-retried-qr')
    await img.waitFor({ state: 'visible' })
    expect(seen.filter((r) => r.method === 'POST' && r.path === '/api/sessions')).toHaveLength(1)
    expect(ctx.pageErrors).toEqual([])
  })

  it('polling lento não sobrepõe consultas de QR', async () => {
    const page = await ctx.newPage()
    await go(ctx, page, '/sessions/new')
    const name = `qr-slow-${randomBytes(4).toString('hex')}`
    await page.locator(tid('new-name')).fill(name)
    let inflight = 0, maximum = 0, completed = 0
    await page.route('**/api/sessions/*/qr', async (route: any) => {
      if (route.request().method() !== 'GET') return route.continue()
      inflight++; maximum = Math.max(maximum, inflight)
      await new Promise((r) => setTimeout(r, 1500))
      await route.fulfill({ status: 200, json: { qr: null, generatedAt: null } })
      inflight--; completed++
    })
    await page.locator(tid('gen-qr')).click()
    await expect.poll(() => completed, { timeout: 10000 }).toBeGreaterThanOrEqual(2)
    expect(maximum).toBe(1)
    await page.close()
  })
})
