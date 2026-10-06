import { describe, expect, it, vi } from 'vitest'
import { SmallGroupModel } from './web-model'
const URL = 'https://chat.whatsapp.com/ABCDEFGHIJKLMNOPQRSTUV'
function setup(response: unknown) {
  const create = vi.fn(async (..._args: unknown[]) => response)
  const settings = vi.fn(async () => ({ enabled: true, config: { apiKey: 'test-key', smallModel: 'cheap-model', largeModel: 'costly-model', timeoutMs: 1000 } }))
  const factory = vi.fn(() => ({ messages: { create } }))
  const model = new SmallGroupModel(settings as never, factory as never)
  return { create, settings, factory, model }
}
describe('modelo pequeno para grupos', () => {
  it('usa somente o modelo pequeno, limita pesquisa e rejeita links inventados', async () => {
    const s = setup({ stop_reason: 'end_turn', content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: URL }] },
      { type: 'text', text: JSON.stringify([{ inviteUrl: URL, topic: 'jogos' }, { inviteUrl: 'https://chat.whatsapp.com/ZYXWVUTSRQPONMLKJIHGFE', topic: 'inventado' }]) },
    ] })
    expect(await s.model.discover('jogos')).toEqual([{ inviteUrl: URL, topic: 'jogos' }])
    expect(s.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'cheap-model', tools: [expect.objectContaining({ max_uses: 1, allowed_domains: ['chat.whatsapp.com'] })] }), expect.any(Object))
    expect(JSON.stringify(s.create.mock.calls)).not.toContain('costly-model')
  })
  it('acha o JSON mesmo com texto antes e depois e em bloco de código', async () => {
    const s = setup({ stop_reason: 'end_turn', content: [
      { type: 'text', text: 'Vou pesquisar grupos [públicos] para você.' },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: URL }] },
      { type: 'text', text: `Encontrei:\n\`\`\`json\n${JSON.stringify([{ inviteUrl: URL, topic: 'jogos [pc]' }])}\n\`\`\`\nEspero ter ajudado.` },
    ] })
    expect(await s.model.discover('jogos')).toEqual([{ inviteUrl: URL, topic: 'jogos [pc]' }])
  })
  it('resposta sem nenhum array vira lista vazia', async () => {
    const s = setup({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Não encontrei grupos.' }] })
    expect(await s.model.discover('jogos')).toEqual([])
  })
  it('não aceita lista de convites sem evidência da ferramenta de pesquisa', async () => {
    const s = setup({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify([{ inviteUrl: URL, topic: 'jogos' }]) }] })
    expect(await s.model.discover('jogos')).toEqual([])
  })
  it('usa as últimas mensagens do grupo como contexto (no máximo 15, a própria como "você")', async () => {
    const s = setup({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Alguém já testou o modo novo?' }] })
    const recent = Array.from({ length: 20 }, (_, i) => ({ author: `Pessoa ${i}`, text: `fala ${i}`, at: i }))
    recent.push({ author: '', text: 'minha postagem', at: 99, fromMe: true } as never)
    await s.model.message('Jogos', 'Roblox', undefined, recent)
    const prompt = JSON.stringify(s.create.mock.calls[0]![0])
    expect(prompt).toContain('últimas mensagens do grupo')
    expect(prompt).toContain('fala 19')
    expect(prompt).not.toContain('fala 5\\')
    expect(prompt).toContain('{\\"autor\\":\\"você\\",\\"texto\\":\\"minha postagem\\"}')
    await s.model.message('Jogos', 'Roblox')
    expect(JSON.stringify(s.create.mock.calls[1]![0])).not.toContain('últimas mensagens do grupo')
  })
  it('gera uma mensagem contextual sem ferramenta de pesquisa', async () => {
    const s = setup({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Qual jogo vocês estão curtindo hoje?' }] })
    expect(await s.model.message('Jogos', 'Roblox', 'Bom dia')).toBe('Qual jogo vocês estão curtindo hoje?')
    const request = s.create.mock.calls[0]?.[0] as unknown as { tools?: unknown; messages: unknown }
    expect(request.tools).toBeUndefined()
    expect(JSON.stringify(request.messages)).toContain('Roblox')
  })
  it.each(['', 'x'.repeat(281), 'Confira https://evil.com'])('rejeita mensagem vazia, longa ou contendo link', async (text) => {
    const s = setup({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })
    await expect(s.model.message('Jogos', 'Roblox')).rejects.toThrow('inválida')
  })
  it('IA desabilitada/chave ausente não faz chamadas pagas', async () => {
    const s = setup({})
    s.settings.mockResolvedValue({ enabled: false, config: { apiKey: '', smallModel: 'cheap-model', largeModel: 'costly-model', timeoutMs: 1000 } })
    await expect(s.model.discover('jogos')).rejects.toThrow('Configure')
    expect(s.create).not.toHaveBeenCalled()
  })
})
