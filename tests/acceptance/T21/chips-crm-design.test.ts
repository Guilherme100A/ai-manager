import { describe, expect, it } from 'vitest'
import { createSession, go, MOBILE, openPage, seedSession, tid, useDashboard } from './shared'

describe('T21 — visual de chips alinhado ao CRM', () => {
  const ctx = useDashboard()

  it('resume os estados sem alterar os controles de cada chip', async () => {
    const connected = await seedSession(ctx)
    await createSession(ctx, { name: `chip-pendente-${Date.now()}` })
    const page = await openPage(ctx)
    await page.route('**/api/sessions/*/conversation', (route) => route.fulfill({ json: {
      config: { mode: 'rotating', enabled: false, targetSessionId: null, topic: 'teste', maxMessagesPerDay: 20, turnsPerConversation: 2, intervalMinutes: 5 },
      activePartnerId: null, state: { turns: 0, pending: null }, accounts: [],
    } }))
    await go(ctx, page, '/sessions')
    await page.locator(tid('session-row')).first().waitFor({ state: 'visible' })

    const states: string[] = await page.locator(tid('session-row')).evaluateAll((rows: Element[]) => rows.map((row) => row.getAttribute('data-state') ?? ''))
    expect(states.length).toBeGreaterThanOrEqual(2)
    expect(Number(await page.locator(tid('chips-total')).textContent())).toBe(states.length)
    expect(Number(await page.locator(tid('chips-connected')).textContent())).toBe(states.filter((state) => ['WARMING', 'STABLE'].includes(state)).length)
    expect(Number(await page.locator(tid('chips-attention')).textContent())).toBe(states.filter((state) => ['NEW', 'DISCONNECTED', 'DEGRADED', 'PAUSED'].includes(state)).length)

    const row = page.locator(`[data-testid="session-row"][data-session-id="${connected.id}"]`)
    expect(await row.locator(tid('session-state')).isVisible()).toBe(true)
    expect(await row.locator(tid('session-proxy')).isVisible()).toBe(true)
    expect(await row.locator(tid('session-delete')).isVisible()).toBe(true)
    await row.locator(tid('session-link')).click()
    await page.locator(tid('session-card')).waitFor({ state: 'visible' })
    await page.locator(tid('session-proxy-panel')).waitFor({ state: 'visible' })
    expect(await page.locator(tid('btn-logs')).isVisible()).toBe(true)
    expect(await page.getByLabel('Ativar conversas nesta conta').isDisabled()).toBe(true)
    expect(await page.getByText('Este chip usa conexão direta.', { exact: false }).isVisible()).toBe(true)
  })

  it('usa a paleta do CRM em claro e escuro; cadastro continua acessível no celular', async () => {
    for (const colorScheme of ['light', 'dark'] as const) {
      const page = await openPage(ctx, { ...MOBILE, colorScheme })
      await go(ctx, page, '/sessions')
      await page.locator(tid('page-sessions')).waitFor({ state: 'visible' })
      const listWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
      expect(listWidth.document, 'a lista de chips não deve exigir rolagem horizontal').toBeLessThanOrEqual(listWidth.viewport + 1)
      expect(await page.locator(tid('chip-list')).count()).toBe(1)
      const skin = await page.locator('.layout-chips').evaluate((el: Element) => {
        const style = getComputedStyle(el)
        return { bg: style.getPropertyValue('--bg').trim(), surface: style.getPropertyValue('--surface').trim(), accent: style.getPropertyValue('--accent').trim() }
      })
      const expected = colorScheme === 'dark'
        ? { bg: '#171326', surface: '#1d1831', accent: '#a78bfa' }
        : { bg: '#f5f3fa', surface: '#fff', accent: '#6d28d9' }
      expect(skin, `scheme=${colorScheme}, theme=${await page.evaluate(() => document.documentElement.dataset.theme)}, actual=${JSON.stringify(skin)}`).toEqual(expected)
      await page.locator(tid('add-session')).click()
      await page.locator(tid('page-new-session')).waitFor({ state: 'visible' })
      expect(await page.locator(tid('new-name')).isVisible()).toBe(true)
      expect(await page.locator(tid('gen-qr')).isVisible()).toBe(true)
      expect(await page.locator(tid('gen-pairing')).isVisible()).toBe(true)
      const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
      expect(width.document).toBeLessThanOrEqual(width.viewport + 1)
    }
  })
})
