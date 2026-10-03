// Harness do T21 (redesign visual do dashboard): o mesmo do T12/T18 (API em processo + FakeTransport + build do
// dashboard na mesma origem + chromium headless), com contextos de browser emulando viewport, tema e movimento.
// Contrato combinado com o Operário (Nácar):
//   tokens em :root: --bg --surface --surface-2 --text --text-muted --border --accent --accent-fg --success --warning
//          --danger --radius --radius-sm --shadow --font-sans (extras permitidos);
//   tema: <html data-theme="light|dark">; sem escolha salva segue prefers-color-scheme; data-testid="theme-toggle" alterna e
//          grava localStorage 'wsm.theme' (o token de login nunca vai para o localStorage);
//   nav:  data-testid="app-nav"; item ativo com aria-current="page"; < 768px os nav-* ficam atrás de data-testid="nav-toggle";
//   estado: session-state/connect-state mantém o texto da SPEC 3.2 e data-state, desenhado como pílula;
//   todos os data-testid anteriores continuam com o mesmo significado; nenhuma chamada de API muda.
import { afterEach, expect } from 'vitest'
import { connectedSession, doLogin, go, tid, type DCtx } from '../T12/shared'

export * from '../T12/shared'

export interface PageOpts {
  login?: boolean
  width?: number
  height?: number
  colorScheme?: 'light' | 'dark'
  reducedMotion?: 'reduce' | 'no-preference'
}

export const DESKTOP = { width: 1440, height: 900 }
export const MOBILE = { width: 390, height: 844 }

// Contextos abertos pelo teste atual: fechados no afterEach para não acumular renderers (memória da máquina é curta).
const openContexts: any[] = []
afterEach(async () => {
  for (const c of openContexts.splice(0)) await c.close().catch(() => {})
})

/** Abre uma página num contexto novo com emulação (fechado ao fim do teste). */
export async function openPage(ctx: DCtx, opts: PageOpts = {}) {
  const { login = true, width = DESKTOP.width, height = DESKTOP.height, colorScheme = 'light', reducedMotion = 'no-preference' } = opts
  const bc = await ctx.browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion })
  openContexts.push(bc)
  const page = await bc.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (e: Error) => ctx.pageErrors.push(e.message))
  await page.addInitScript(COLOR_LIB)
  if (login) await doLogin(ctx, page)
  return page
}

// ---- rotas do tour ------------------------------------------------------------------------

export interface TourStop {
  name: string
  hash: string
  ready: string
}

/** Todas as telas do painel. `sessionId` é uma sessão conectada (detalhe com card e gráficos). */
export function tour(sessionId: string): TourStop[] {
  return [
    { name: 'home', hash: '/', ready: 'page-home' },
    { name: 'sessions', hash: '/sessions', ready: 'page-sessions' },
    { name: 'new-session', hash: '/sessions/new', ready: 'page-new-session' },
    { name: 'session', hash: `/sessions/${sessionId}`, ready: 'page-session' },
    { name: 'contacts', hash: '/contacts', ready: 'page-contacts' },
    { name: 'groups', hash: '/groups', ready: 'page-groups' },
    { name: 'alerts', hash: '/alerts', ready: 'page-alerts' },
    { name: 'ai', hash: '/ai', ready: 'page-ai' },
  ]
}

export async function visit(ctx: DCtx, page: any, stop: TourStop) {
  await go(ctx, page, stop.hash)
  await page.locator(tid(stop.ready)).first().waitFor({ state: 'attached' })
  // dados carregados (sem reticências de carregamento em cards) e layout estável
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(150)
}

const seeded = new WeakMap<DCtx, Promise<{ id: string; name: string }>>()
/** Uma sessão conectada por harness (reaproveitada entre os testes do arquivo). */
export function seedSession(ctx: DCtx) {
  if (!seeded.has(ctx)) seeded.set(ctx, connectedSession(ctx).then(({ id, name }) => ({ id, name })))
  return seeded.get(ctx)!
}

// ---- tokens / tema --------------------------------------------------------------------------

export const TOKENS = [
  '--bg',
  '--surface',
  '--surface-2',
  '--text',
  '--text-muted',
  '--border',
  '--accent',
  '--accent-fg',
  '--success',
  '--warning',
  '--danger',
  '--radius',
  '--radius-sm',
  '--shadow',
  '--font-sans',
] as const

export const readTokens = (page: any): Promise<Record<string, string>> =>
  page.evaluate((names: string[]) => {
    const cs = getComputedStyle(document.documentElement)
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]))
  }, [...TOKENS])

export const themeOf = (page: any): Promise<string | null> => page.evaluate(() => document.documentElement.getAttribute('data-theme'))

// ---- cor e contraste (no browser) -------------------------------------------------------------

/**
 * Script injetado: normaliza qualquer cor CSS (rgb, hex, oklch, color-mix…) para RGBA via canvas, compõe o fundo
 * efetivo subindo pelos ancestrais (alfa) e calcula a razão de contraste WCAG 2.x.
 */
export const COLOR_LIB = `
window.__wsmColor = (function () {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const g = cv.getContext('2d', { willReadFrequently: true })
  function rgba(c) {
    if (!c || c === 'transparent') return [0, 0, 0, 0]
    g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1)
    const d = g.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  function over(top, bottom) {
    const a = top[3] + bottom[3] * (1 - top[3])
    if (a === 0) return [0, 0, 0, 0]
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat([a])
  }
  function effectiveBg(el) {
    const layers = []
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    // sem fundo opaco na cadeia (ex.: gradiente no body): usa o token --bg; por fim, branco
    let acc = [255, 255, 255, 1]
    if (!layers.length || layers[layers.length - 1][3] < 1) {
      const probe = document.createElement('div'); probe.style.background = 'var(--bg)'; document.body.appendChild(probe)
      const b = rgba(getComputedStyle(probe).backgroundColor); probe.remove()
      if (b[3] > 0) acc = over(b, acc)
    }
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc)
    return acc
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  function contrastOf(el) {
    const bg = effectiveBg(el)
    const fg = over(rgba(getComputedStyle(el).color), bg)
    return { ratio: ratio(fg, bg), fg: fg.map((v) => Math.round(v)), bg: bg.map((v) => Math.round(v)) }
  }
  function resolveVar(name, prop) {
    const probe = document.createElement('div'); probe.style[prop || 'backgroundColor'] = 'var(' + name + ')'; document.body.appendChild(probe)
    const v = getComputedStyle(probe)[prop || 'backgroundColor']; probe.remove(); return v
  }
  /** Elementos visíveis com texto próprio cujo contraste fica abaixo do mínimo AA (4.5; 3.0 para texto grande). */
  function lowContrast(root) {
    const out = []
    const all = (root || document.body).querySelectorAll('*')
    for (const el of all) {
      if (el.closest('svg, [aria-hidden="true"], [disabled], [aria-disabled="true"], option, script, style, noscript')) continue
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0)
      if (!own) continue
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue
      const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700
      const min = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
      const c = contrastOf(el)
      if (c.ratio < min) out.push({ tag: el.tagName.toLowerCase(), testid: el.closest('[data-testid]')?.getAttribute('data-testid') || null, text: el.textContent.trim().slice(0, 40), ratio: Math.round(c.ratio * 100) / 100, min, fg: c.fg, bg: c.bg })
    }
    return out
  }
  return { rgba, effectiveBg, ratio, contrastOf, resolveVar, lowContrast }
})()
`

/** Contraste do primeiro elemento visível do seletor. */
export async function contrastOf(page: any, selector: string): Promise<{ ratio: number; fg: number[]; bg: number[] } | null> {
  return page.evaluate((sel: string) => {
    const el = Array.from(document.querySelectorAll(sel)).find((e) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed')
    return el ? (window as any).__wsmColor.contrastOf(el) : null
  }, selector)
}

export const bodyBg = (page: any): Promise<number[]> =>
  page.evaluate(() => (window as any).__wsmColor.rgba(getComputedStyle(document.body).backgroundColor))

export const colorDistance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// ---- navegação -------------------------------------------------------------------------------

export const NAV_LINKS = ['nav-home', 'nav-sessions', 'nav-contacts', 'nav-groups', 'nav-alerts', 'nav-ai']

/** Garante que os links do nav estejam visíveis (abre o nav-toggle quando existir e estiver visível). */
export async function ensureNavOpen(page: any) {
  const link = page.locator(tid('nav-sessions')).first()
  if (await link.isVisible()) return
  const toggle = page.locator(tid('nav-toggle')).first()
  expect(await toggle.isVisible(), 'links do nav ocultos e sem nav-toggle visível').toBe(true)
  await toggle.click()
  await link.waitFor({ state: 'visible' })
}

// ---- API ---------------------------------------------------------------------------------------

/** Chamadas que o painel fazia antes do redesign (apps/dashboard/src/lib/api.ts + AiSettings.logic.ts) e a do T20. */
export const API_ALLOWLIST: Array<[string, RegExp]> = [
  ['POST', /^\/api\/auth\/login$/],
  ['GET', /^\/api\/auth\/me$/],
  ['POST', /^\/api\/auth\/logout$/],
  ['GET', /^\/api\/sessions$/],
  ['POST', /^\/api\/sessions$/],
  ['GET', /^\/api\/sessions\/[^/]+$/],
  ['PATCH', /^\/api\/sessions\/[^/]+$/],
  ['POST', /^\/api\/sessions\/[^/]+\/qr$/],
  ['GET', /^\/api\/sessions\/[^/]+\/qr$/],
  ['POST', /^\/api\/sessions\/[^/]+\/pairing-code$/],
  ['POST', /^\/api\/sessions\/[^/]+\/(pause|resume|restart|logout)$/],
  ['GET', /^\/api\/sessions\/[^/]+\/health$/],
  ['GET', /^\/api\/sessions\/[^/]+\/groups$/],
  ['POST', /^\/api\/sessions\/[^/]+\/groups\/refresh$/],
  ['POST', /^\/api\/sessions\/[^/]+\/groups\/[^/]+\/participants$/], // T20
  // Recursos posteriores ao T21: conversas entre contas, automação/convite de grupos, vínculos e exclusão de sessão.
  ['DELETE', /^\/api\/sessions\/[^/]+$/],
  ['GET', /^\/api\/sessions\/[^/]+\/conversation$/],
  ['PUT', /^\/api\/sessions\/[^/]+\/conversation$/],
  ['POST', /^\/api\/sessions\/[^/]+\/conversation\/run$/],
  ['GET', /^\/api\/sessions\/[^/]+\/groups\/automation$/],
  ['PUT', /^\/api\/sessions\/[^/]+\/groups\/automation$/],
  ['POST', /^\/api\/sessions\/[^/]+\/groups\/automation\/run$/],
  ['POST', /^\/api\/sessions\/[^/]+\/groups\/invite-flow$/],
  ['GET', /^\/api\/session-links(\/runs)?$/],
  ['POST', /^\/api\/session-links$/],
  ['PATCH', /^\/api\/session-links\/[^/]+$/],
  ['DELETE', /^\/api\/session-links\/[^/]+$/],
  // Limite de chips por IP (botão na página de sessões).
  ['GET', /^\/api\/proxy-sharing$/],
  ['PUT', /^\/api\/proxy-sharing$/],
  ['GET', /^\/api\/messages$/],
  ['GET', /^\/api\/messages\/[^/]+\/events$/],
  ['GET', /^\/api\/contacts$/],
  ['POST', /^\/api\/contacts\/import$/],
  ['GET', /^\/api\/webhooks$/],
  ['POST', /^\/api\/webhooks$/],
  ['PATCH', /^\/api\/webhooks\/[^/]+$/],
  ['DELETE', /^\/api\/webhooks\/[^/]+$/],
  ['POST', /^\/api\/webhooks\/[^/]+\/test$/],
  ['GET', /^\/api\/ai\/settings$/],
  ['PUT', /^\/api\/ai\/settings$/],
  ['POST', /^\/api\/ai\/settings\/test$/],
  ['GET', /^\/metrics$/],
]

export const allowed = (method: string, path: string) => API_ALLOWLIST.some(([m, re]) => m === method && re.test(path))
