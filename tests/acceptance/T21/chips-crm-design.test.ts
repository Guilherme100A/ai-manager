import { describe, expect, it } from 'vitest'
import { createSession, go, MOBILE, openPage, seedSession, tid, useDashboard } from './shared'

function normalizeHexColor(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(value)) return '#' + [...value.slice(1)].map((digit) => digit + digit).join('')
  if (/^#[0-9a-f]{6}$/.test(value)) return value
  throw new Error(`Invalid CSS hex color: ${JSON.stringify(raw)}`)
}

describe('T21 — normalizacao estrita de cores hex', () => {
  it.each([
    ['#fff', '#ffffff'],
    [' #FFF ', '#ffffff'],
    ['#AbC', '#aabbcc'],
    ['\t#AaBbCc\n', '#aabbcc'],
    ['#09090b', '#09090b'],
  ])('normaliza %j como %j', (raw, expected) => {
    expect(normalizeHexColor(raw)).toBe(expected)
    expect(normalizeHexColor(raw)).toBe(normalizeHexColor(expected))
  })

  it('preserva diferencas reais sem tolerancia de canal', () => {
    expect(normalizeHexColor('#fefefe')).not.toBe(normalizeHexColor('#ffffff'))
  })

  it.each(['', ' \t\n', '#ff', '#ffff', '#fffff', '#ffffffff', '#ggg', '#fffffg', 'ffffff', 'red', 'rgb(255, 255, 255)', '#ff f'])('rejeita %j sem default', (raw) => {
    expect(() => normalizeHexColor(raw)).toThrow(`Invalid CSS hex color: ${JSON.stringify(raw)}`)
  })
})

describe('T21 — visual neutro de chips integrado ao T002', () => {
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

  it('usa a paleta neutra do painel em claro e escuro; cadastro continua acessível no celular', async () => {
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
        ? { bg: '#09090b', surface: '#111114', accent: '#8b8dff' }
        : { bg: '#fafafa', surface: '#ffffff', accent: '#4f46e5' }
      const diagnostic = `scheme=${colorScheme}, theme=${await page.evaluate(() => document.documentElement.dataset.theme)}, actual=${JSON.stringify(skin)}, expected=${JSON.stringify(expected)}`
      for (const token of ['bg', 'surface', 'accent'] as const) {
        expect(normalizeHexColor(skin[token]), `${diagnostic}, token=${token}`).toBe(normalizeHexColor(expected[token]))
      }
      expect(await page.evaluate(() => (window as Window & { __wsmColor: { lowContrast(root: Element | null): unknown[] } }).__wsmColor.lowContrast(document.querySelector('.layout')))).toEqual([])
      await page.locator(tid('add-session')).click()
      await page.locator(tid('page-new-session')).waitFor({ state: 'visible' })
      expect(await page.locator(tid('new-name')).isVisible()).toBe(true)
      expect(await page.locator(tid('gen-qr')).isVisible()).toBe(true)
      expect(await page.locator(tid('gen-pairing')).isVisible()).toBe(true)
      const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
      expect(width.document).toBeLessThanOrEqual(width.viewport + 1)
      expect(await page.evaluate(() => (window as Window & { __wsmColor: { lowContrast(root: Element | null): unknown[] } }).__wsmColor.lowContrast(document.querySelector('.layout')))).toEqual([])
    }
  })
})
