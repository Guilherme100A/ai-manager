import { describe, expect, it, vi } from 'vitest'
import { FallbackConversationModel, PhraseConversationModel } from './fallback'
import { ConversationAiDisabledError } from './index'

const seeded = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

describe('banco de frases (reserva sem IA)', () => {
  it('devolve o número de partes pedido, uma por linha, sem links nem barra', async () => {
    const model = new PhraseConversationModel(seeded(7))
    for (const parts of [1, 2, 3]) {
      const lines = (await model.message('jogos', 'a', [], parts)).split('\n')
      expect(lines).toHaveLength(parts)
      for (const line of lines) {
        expect(line.trim()).not.toBe('')
        expect(line).not.toMatch(/https?:|\//)
      }
    }
  })

  it('não repete a mesma fala do chip dentro de uma hora de conversa (limite de idênticas do antiban)', async () => {
    const model = new PhraseConversationModel(seeded(42))
    const seen = new Map<string, number>()
    const history: { senderId: string; text: string }[] = []
    // ~30 disparos/h de até 3 partes, alternando com a outra conta.
    for (let i = 0; i < 30; i++) {
      const text = await model.message('jogos', 'a', history, 1 + (i % 3))
      for (const line of text.split('\n')) seen.set(line, (seen.get(line) ?? 0) + 1)
      history.push({ senderId: 'a', text }, { senderId: 'b', text: i % 2 ? 'Tudo certo?' : 'Boa' })
    }
    expect(Math.max(...seen.values())).toBeLessThan(3)
  })

  it('não usa fala que já está no histórico recente', async () => {
    const history = [{ senderId: 'b', text: 'Você viu?' }]
    for (let seed = 1; seed < 40; seed++) {
      const text = await new PhraseConversationModel(seeded(seed)).message('jogos', 'a', [...history, { senderId: 'a', text: 'Acho que sim' }, { senderId: 'b', text: 'E aí?' }])
      expect(text.split('\n').map((l) => l.toLowerCase())).not.toContain('acho que sim')
    }
  })

  it('não faz pergunta nova enquanto a própria pergunta está sem resposta', async () => {
    for (let seed = 1; seed < 40; seed++) {
      const text = await new PhraseConversationModel(seeded(seed)).message('jogos', 'a', [{ senderId: 'b', text: 'boa' }, { senderId: 'a', text: 'E você?' }], 3)
      expect(text).not.toContain('?')
    }
  })
})

describe('FallbackConversationModel', () => {
  it('usa a IA quando ela responde', async () => {
    const fallback = { message: vi.fn(async () => 'reserva') }
    const model = new FallbackConversationModel({ message: async () => 'da IA' }, fallback)
    expect(await model.message('t', 'a', [])).toBe('da IA')
    expect(fallback.message).not.toHaveBeenCalled()
  })

  it('cai no banco de frases quando a IA falha (ex.: sem crédito) e registra o motivo', async () => {
    const warn = vi.fn()
    const model = new FallbackConversationModel(
      { message: async () => { throw new Error('400 Your credit balance is too low') } },
      { message: async (_t, _s, _h, parts) => `reserva ${parts}` },
      { warn },
    )
    expect(await model.message('t', 'a', [], 2)).toBe('reserva 2')
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'a', err: expect.stringContaining('credit') }), expect.any(String))
  })

  it('com a IA desligada usa as frases sem registrar falha', async () => {
    const warn = vi.fn()
    const model = new FallbackConversationModel(
      { message: async () => { throw new ConversationAiDisabledError() } },
      { message: async () => 'reserva' },
      { warn },
    )
    expect(await model.message('t', 'a', [])).toBe('reserva')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('cumprimento', () => {
  it('responde ao "tudo bem?" mesmo quando a fala da outra conta tem várias linhas', async () => {
    const greetingReplies = /tudo|bem|boa|luta|paz|certo/i
    for (let seed = 1; seed < 20; seed++) {
      const text = await new PhraseConversationModel(seeded(seed)).message('jogos', 'b', [{ senderId: 'a', text: 'Oii, tudo joia?\nAcabei de chegar em casa' }])
      expect(text).toMatch(greetingReplies)
    }
  })
})
