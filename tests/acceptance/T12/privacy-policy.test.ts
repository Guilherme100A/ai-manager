import { describe, expect, it } from 'vitest'
import { useDashboard } from './shared'

describe('Política de Privacidade pública', () => {
  const ctx = useDashboard()

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    it(`abre sem login em ${viewport.width}px`, async () => {
      const page = await ctx.newPage({ login: false })
      await page.setViewportSize(viewport)
      const response = await page.goto(`${ctx.base}/privacidade.html`)
      expect(response?.status()).toBe(200)
      expect(response?.headers()['content-type']).toContain('text/html')
      expect(await page.locator('h1').textContent()).toBe('Política de Privacidade')
      expect(await page.locator('main').isVisible()).toBe(true)
      expect(await page.locator('.pending, .draft').count(), 'nenhum campo de rascunho pode ir ao ar').toBe(0)
      expect(await page.locator('main section').count()).toBe(10)
      expect(await page.locator('a[href="mailto:tuskelegalrosa@gmail.com"]').count()).toBeGreaterThan(0)
      expect(await page.locator('script, iframe').count()).toBe(0)
      expect(await page.locator('meta[name="robots"]').count()).toBe(0)
      const copy = await page.locator('main').innerText()
      for (const topic of ['controladora', 'operador', 'Finalidades e bases legais', 'Compartilhamento e fornecedores', 'Conservação e eliminação', 'Segurança e incidentes', 'Seus direitos', 'Crianças e adolescentes', 'Transferências internacionais'])
        expect(copy).toContain(topic)
      expect(copy).not.toMatch(/\[[^\]]*(PENDENTE|CONFIRMAR|NOME OU RAZÃO SOCIAL)[^\]]*\]/i)
      expect(await page.locator('html').getAttribute('lang')).toBe('pt-BR')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await page.evaluate(() => sessionStorage.getItem('wsm.token'))).toBeNull()
    })
  }
})
