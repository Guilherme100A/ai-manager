import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StickerScorer } from '@wsm/core'
import { COLLECTED_DIR, fileStickerPool, PENDING_DIR } from './stickers'

const webp = (tag: string) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(tag)])
const dirs: string[] = []
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'stickers-')); dirs.push(d); return d }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
const list = async (d: string) => (await readdir(d).catch(() => [] as string[])).filter((f) => f.endsWith('.webp')).sort()
const PRIVATE = { chatId: '5511@s.whatsapp.net' }

/** Avaliador falso: a nota vem do conteúdo ("nsfw" → 0.9, "ruim" → erro de imagem). */
function fakeScorer(opts: { failLoad?: boolean } = {}) {
  const scorer = {
    ready: vi.fn(async () => { if (opts.failLoad) throw new Error('wasm') }),
    score: vi.fn(async (data: Buffer) => {
      const tag = data.subarray(12).toString()
      if (tag.startsWith('ruim')) throw new Error('not an image')
      return tag.startsWith('nsfw') ? 0.9 : 0.1
    }),
    release: vi.fn(async () => undefined),
  } satisfies StickerScorer
  return scorer
}

describe('figurinhas do aquecimento', () => {
  it('pasta vazia ou inexistente: não sorteia nada', async () => {
    expect(await fileStickerPool(join(await temp(), 'nao-existe')).pick(() => 0)).toBeUndefined()
    expect(await fileStickerPool(await temp()).pick(() => 0)).toBeUndefined()
  })

  it('sorteia entre as .webp da pasta e as coletadas (ignora outros arquivos)', async () => {
    const dir = await temp()
    await writeFile(join(dir, 'minha.webp'), webp('a'))
    await writeFile(join(dir, 'foto.png'), 'x')
    const pool = fileStickerPool(dir)
    await pool.save('abcdef0123456789', webp('b'), PRIVATE)
    const picks = new Set([await pool.pick(() => 0), await pool.pick(() => 0.99)])
    expect([...picks].sort()).toEqual([join(dir, 'minha.webp'), join(dir, COLLECTED_DIR, 'abcdef0123456789.webp')].sort())
  })

  it('só guarda webp de verdade, sem repetir; estoque cheio apaga as mais antigas em lote e continua', async () => {
    const dir = await temp()
    const pool = fileStickerPool(dir, { maxCollected: 4, rotateBatch: 2 })
    await pool.save('aaaaaaaaaaaaaaaa', Buffer.from('não é webp'), PRIVATE)
    await pool.save('../fora', webp('x'), PRIVATE)
    expect(await readdir(dir)).toEqual([])
    const ids = ['1111111111111111', '2222222222222222', '3333333333333333', '4444444444444444']
    for (const [i, id] of ids.entries()) {
      await pool.save(id, webp(id), PRIVATE)
      await utimes(join(dir, COLLECTED_DIR, `${id}.webp`), new Date(1_000 * (i + 1)), new Date(1_000 * (i + 1)))
    }
    await pool.save(ids[0]!, webp('repetida'), PRIVATE) // já está no estoque: ignora
    expect(await list(join(dir, COLLECTED_DIR))).toHaveLength(4)
    await pool.save('5555555555555555', webp('5'), PRIVATE) // cheio: apaga as 2 mais antigas e guarda a nova
    expect(await list(join(dir, COLLECTED_DIR))).toEqual(['3333333333333333.webp', '4444444444444444.webp', '5555555555555555.webp'])
  })

  it('grupo com nome suspeito: recusa antes de baixar (normaliza acento e letras estilizadas)', async () => {
    const dir = await temp()
    const pool = fileStickerPool(dir)
    expect(pool.accepts!('aaaaaaaaaaaaaaaa', { chatId: 'g@g.us', groupName: '⚜️IMPERIAL HOT🔥' })).toBe(false)
    expect(pool.accepts!('aaaaaaaaaaaaaaaa', { chatId: 'g@g.us', groupName: '𝐏𝐔𝐓𝐀𝐑𝐈𝐀 liberada' })).toBe(false)
    expect(pool.accepts!('aaaaaaaaaaaaaaaa', { chatId: 'g@g.us', groupName: 'Grupo 🔞' })).toBe(false)
    expect(pool.accepts!('aaaaaaaaaaaaaaaa', { chatId: 'g@g.us', groupName: 'Network Digital' })).toBe(true)
    expect(pool.accepts!('aaaaaaaaaaaaaaaa', { chatId: 'g@g.us' })).toBe(true) // nome desconhecido: segue para o NSFWJS
    expect(pool.accepts!('aaaaaaaaaaaaaaaa', PRIVATE)).toBe(true)
    await pool.save('aaaaaaaaaaaaaaaa', webp('a'), { chatId: 'g@g.us', groupName: 'Hot money' })
    expect(await list(join(dir, COLLECTED_DIR))).toEqual([])
    const custom = fileStickerPool(dir, { blockedGroupWords: ['divulga'] })
    expect(custom.accepts!('aaaaaaaaaaaaaaaa', { chatId: 'g@g.us', groupName: 'Fusion Networking Dilvulga' })).toBe(true)
    expect(custom.accepts!('aaaaaaaaaaaaaaaa', { chatId: 'g@g.us', groupName: 'Hot money divulgação' })).toBe(false)
  })

  it('com NSFWJS: recebidas esperam em pendentes; a rodada aprova, apaga as impróprias e lembra o id', async () => {
    const dir = await temp()
    const scorer = fakeScorer()
    const pool = fileStickerPool(dir, { scorer, maxPending: 3 })
    await pool.save('aaaaaaaaaaaaaaaa', webp('ok'), PRIVATE)
    await pool.save('bbbbbbbbbbbbbbbb', webp('nsfw'), PRIVATE)
    await pool.save('cccccccccccccccc', webp('ruim'), PRIVATE)
    await pool.save('dddddddddddddddd', webp('ok'), PRIVATE) // fila cheia: ignora
    expect(await list(join(dir, COLLECTED_DIR, PENDING_DIR))).toHaveLength(3)
    expect(await pool.pick(() => 0)).toBeUndefined() // pendente não é sorteada
    expect(scorer.score).not.toHaveBeenCalled() // nada é avaliado na chegada

    expect(await pool.processPending()).toEqual({ approved: 1, blocked: 1, failed: 1 })
    expect(await list(join(dir, COLLECTED_DIR))).toEqual(['aaaaaaaaaaaaaaaa.webp'])
    expect(await list(join(dir, COLLECTED_DIR, PENDING_DIR))).toEqual([])
    expect(scorer.release).toHaveBeenCalledTimes(1) // modelo sai da memória depois da rodada

    await pool.save('bbbbbbbbbbbbbbbb', webp('nsfw'), PRIVATE) // reprovada repostada: nem entra na fila
    expect(await list(join(dir, COLLECTED_DIR, PENDING_DIR))).toEqual([])
    scorer.ready.mockClear()
    expect(await pool.processPending()).toEqual({ approved: 0, blocked: 0, failed: 0 })
    expect(scorer.ready).not.toHaveBeenCalled() // fila vazia: nem carrega o modelo
  })

  it('modelo não carrega: as pendentes ficam para a próxima rodada', async () => {
    const dir = await temp()
    const pool = fileStickerPool(dir, { scorer: fakeScorer({ failLoad: true }) })
    await pool.save('aaaaaaaaaaaaaaaa', webp('ok'), PRIVATE)
    expect(await pool.processPending()).toEqual({ approved: 0, blocked: 0, failed: 0 })
    expect(await list(join(dir, COLLECTED_DIR, PENDING_DIR))).toEqual(['aaaaaaaaaaaaaaaa.webp'])
  })
})
