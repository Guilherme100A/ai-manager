import { describe, expect, it, vi } from 'vitest'
import { SmallGroupModel, topicSlugs } from './web-model'
const URL = 'https://chat.whatsapp.com/ABCDEFGHIJKLMNOPQRSTUV'
function setup(response: unknown, pages: Record<string, string | number> = {}) {
  const create = vi.fn(async (..._args: unknown[]) => response)
  const settings = vi.fn(async () => ({ enabled: true, config: { apiKey: 'test-key', smallModel: 'cheap-model', largeModel: 'costly-model', timeoutMs: 1000 } }))
  const factory = vi.fn(() => ({ messages: { create } }))
  const fetcher = vi.fn(async (url: string) => {
    const page = pages[url.split('/').pop()!]
    if (page === undefined) return new Response('', { status: 404 })
    if (typeof page === 'number') return new Response('', { status: page })
    return new Response(page, { status: 200 })
  })
  const model = new SmallGroupModel(settings as never, factory as never, fetcher as never)
  return { create, settings, factory, fetcher, model }
}
describe('modelo pequeno para grupos', () => {
  it('transforma o tema em páginas do diretório', () => {
    expect(topicSlugs('Jogos e Tecnologia, grupos brasileiros')).toEqual(['jogos', 'tecnologia'])
    expect(topicSlugs('Mecânica de motos, carros e caminhões')).toEqual(['mecanica', 'motos', 'carros'])
  })
  it('lê os convites das páginas de tema, sem duplicar e sem chamar o modelo', async () => {
    const other = 'https://chat.whatsapp.com/ZYXWVUTSRQPONMLKJIHGFE'
    const s = setup({}, {
      jogos: `<a href="${URL}">A</a> <a href="${URL}?x">A de novo</a> <a href="https://chat.whatsapp.com/invite/ZYXWVUTSRQPONMLKJIHGFE">B</a>`,
      tecnologia: `<a href="${other}">B repetido</a> <a href="https://evil.com/ABCDEFGHIJKLMNOPQRSTUV">fora</a>`,
    })
    expect(await s.model.discover('jogos e tecnologia')).toEqual([{ inviteUrl: URL, topic: 'jogos' }, { inviteUrl: other, topic: 'jogos' }])
    expect(s.fetcher).toHaveBeenCalledTimes(2)
    expect(s.create).not.toHaveBeenCalled()
  })
  it('tema que falha não derruba os outros; diretório inteiro fora do ar vira erro', async () => {
    const s = setup({}, { jogos: 503, tecnologia: `<a href="${URL}">A</a>` })
    expect(await s.model.discover('jogos tecnologia')).toEqual([{ inviteUrl: URL, topic: 'tecnologia' }])
    const t = setup({}, { jogos: 503 })
    await expect(t.model.discover('jogos')).rejects.toThrow('indisponível')
  })
  it.each([['SIM', true], ['Sim.', true], ['NAO', false], ['Não, é divulgação', false], ['Talvez', false]])('juiz: resposta %s → %s', async (text, expected) => {
    const s = setup({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })
    expect(await s.model.judge({ name: 'COD Mobile Brasil', description: 'Bate-papo', topic: 'jogos' })).toBe(expected)
    const request = s.create.mock.calls[0]?.[0] as { model: string; tools?: unknown; messages: unknown }
    expect(request.model).toBe('cheap-model')
    expect(request.tools).toBeUndefined()
    expect(JSON.stringify(request.messages)).toContain('COD Mobile Brasil')
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
    await expect(s.model.judge({ name: 'Jogos', topic: 'jogos' })).rejects.toThrow('Configure')
    expect(s.create).not.toHaveBeenCalled()
  })
})
