import { describe, expect, it, vi } from 'vitest'
import { SmallConversationModel } from './index'
function setup(text = 'Qual jogo você recomenda?') {
  const create = vi.fn(async (..._args: unknown[]) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }))
  const settings = vi.fn(async () => ({ enabled: true, config: { apiKey: 'test', smallModel: 'small', largeModel: 'large', timeoutMs: 1000 } }))
  const model = new SmallConversationModel(settings as never, (() => ({ messages: { create } })) as never)
  return { model, create, settings }
}
describe('modelo de conversas', () => {
  it('usa apenas small, sem ferramentas, com histórico limitado', async () => {
    const s = setup()
    await s.model.message('jogos', 'a', Array.from({ length: 12 }, (_, i) => ({ senderId: 'b', text: `fala-${i}` })))
    const request = s.create.mock.calls[0]![0] as { model: string; tools?: unknown; messages: unknown }
    expect(request.model).toBe('small'); expect(request.tools).toBeUndefined()
    expect(JSON.stringify(request.messages)).toContain('fala-11'); expect(JSON.stringify(request.messages)).not.toContain('fala-0"')
    expect(s.create).toHaveBeenCalledTimes(1)
  })
  it.each(['', 'x'.repeat(301), 'https://example.com'])('rejeita fala inválida', async (text) => {
    await expect(setup(text).model.message('jogos', 'a', [])).rejects.toThrow('inválida')
  })
  it('IA desativada não chama provedor', async () => {
    const s = setup(); s.settings.mockResolvedValue({ enabled: false, config: { apiKey: '', smallModel: 'small', largeModel: 'large', timeoutMs: 1000 } })
    await expect(s.model.message('jogos', 'a', [])).rejects.toThrow('Habilite')
    expect(s.create).not.toHaveBeenCalled()
  })
})
