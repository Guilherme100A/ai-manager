import { describe, expect, it, vi } from 'vitest'
import { SmallStickerModerator } from './sticker-safety'

function setup(reply: { stop_reason: string; text?: string } | Error, enabled = true) {
  const create = vi.fn(async (..._args: unknown[]) => {
    if (reply instanceof Error) throw reply
    return { stop_reason: reply.stop_reason, content: [{ type: 'text', text: reply.text ?? '' }] }
  })
  const settings = vi.fn(async () => ({ enabled, config: { apiKey: 'test', smallModel: 'small', largeModel: 'large', timeoutMs: 1000 } }))
  const frames = vi.fn(async () => [Buffer.from('png1'), Buffer.from('png2')])
  const moderator = new SmallStickerModerator(settings as never, (() => ({ messages: { create } })) as never, frames)
  return { moderator, create, frames }
}

describe('filtro de figurinhas', () => {
  it('manda os quadros como imagens e só libera com OK', async () => {
    const { moderator, create } = setup({ stop_reason: 'end_turn', text: 'OK' })
    expect(await moderator.review(Buffer.from('webp'))).toBe('ok')
    const content = (create.mock.calls[0]![0] as { messages: { content: Array<{ type: string }> }[] }).messages[0]!.content
    expect(content.map((c) => c.type)).toEqual(['image', 'image', 'text'])
  })
  it.each([
    [{ stop_reason: 'end_turn', text: 'BLOQUEAR' }, 'blocked'],
    [{ stop_reason: 'end_turn', text: 'bloquear.' }, 'blocked'],
    [{ stop_reason: 'refusal' }, 'blocked'],
    [{ stop_reason: 'end_turn', text: 'talvez' }, 'unknown'],
    [{ stop_reason: 'max_tokens', text: 'O' }, 'unknown'],
    [new Error('network'), 'unknown'],
  ] as const)('%o → %s', async (reply, verdict) => {
    expect(await setup(reply as never).moderator.review(Buffer.from('webp'))).toBe(verdict)
  })
  it('IA desligada não chama o provedor e não decide', async () => {
    const { moderator, create } = setup({ stop_reason: 'end_turn', text: 'OK' }, false)
    expect(await moderator.review(Buffer.from('webp'))).toBe('unknown')
    expect(create).not.toHaveBeenCalled()
  })
  it('arquivo que não abre como imagem é reprovado sem chamar o provedor', async () => {
    const { moderator, create, frames } = setup({ stop_reason: 'end_turn', text: 'OK' })
    frames.mockRejectedValueOnce(new Error('bad image'))
    expect(await moderator.review(Buffer.from('lixo'))).toBe('blocked')
    expect(create).not.toHaveBeenCalled()
  })
})
