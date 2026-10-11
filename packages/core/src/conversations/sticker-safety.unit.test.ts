import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { nsfwjsScorer, stickerFrames } from './sticker-safety'

const frame = (i: number) => sharp({ create: { width: 64, height: 64, channels: 4, background: { r: (i * 25) % 256, g: 200 - ((i * 15) % 200), b: 120, alpha: 1 } } }).png().toBuffer()
/** Figurinha estática (1 quadro) ou animada (vários quadros). */
const solid = async (pages = 1) => {
  const frames = await Promise.all(Array.from({ length: pages }, (_, i) => frame(i)))
  return (pages > 1 ? sharp(frames, { join: { animated: true } }) : sharp(frames[0])).webp({ lossless: true }).toBuffer()
}

describe('filtro local de figurinhas (NSFWJS)', () => {
  it('extrai até 4 quadros espalhados das animadas e 1 das estáticas', async () => {
    expect(await stickerFrames(await solid())).toHaveLength(1)
    const frames = await stickerFrames(await solid(10))
    expect(frames).toHaveLength(4)
    expect(frames[0]!.data.length).toBe(224 * 224 * 3)
  })

  it('carrega o modelo em WebAssembly, dá nota de 0 a 1 e libera a memória', async () => {
    const scorer = nsfwjsScorer()
    await scorer.ready()
    const score = await scorer.score(await solid())
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThan(0.5) // um quadrado azul não é impróprio
    await scorer.release()
    expect(await scorer.score(await solid(3))).toBeLessThan(0.5) // recarrega depois de liberar
    await scorer.release()
    await expect(scorer.score(Buffer.from('não é imagem'))).rejects.toThrow()
  }, 120_000)
})
