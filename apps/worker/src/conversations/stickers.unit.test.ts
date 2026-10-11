import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StickerVerdict } from '@wsm/core'
import { BLOCKED_DIR, COLLECTED_DIR, fileStickerPool } from './stickers'

const webp = (tag: string) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(tag)])
const dirs: string[] = []
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'stickers-')); dirs.push(d); return d }
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })

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
    await pool.save('abcdef0123456789', webp('b'))
    const picks = new Set([await pool.pick(() => 0), await pool.pick(() => 0.99)])
    expect([...picks].sort()).toEqual([join(dir, 'minha.webp'), join(dir, COLLECTED_DIR, 'abcdef0123456789.webp')].sort())
  })
  it('só guarda webp de verdade, sem repetir, e para de coletar com o estoque cheio', async () => {
    const dir = await temp()
    const pool = fileStickerPool(dir, { maxCollected: 2 })
    await pool.save('aaaaaaaaaaaaaaaa', Buffer.from('não é webp'))
    await pool.save('../fora', webp('x'))
    expect(await readdir(dir)).toEqual([])
    await pool.save('aaaaaaaaaaaaaaaa', webp('1'))
    await pool.save('aaaaaaaaaaaaaaaa', webp('1')) // repetida: ignora
    await pool.save('bbbbbbbbbbbbbbbb', webp('2'))
    await pool.save('cccccccccccccccc', webp('3')) // estoque cheio: não guarda nem troca as antigas
    expect((await readdir(join(dir, COLLECTED_DIR))).sort()).toEqual(['aaaaaaaaaaaaaaaa.webp', 'bbbbbbbbbbbbbbbb.webp'])
  })
  it('com filtro: só guarda e sorteia as aprovadas; revisão apaga impróprias e deixa as sem veredito de fora', async () => {
    const dir = await temp()
    const verdicts: Record<string, StickerVerdict> = { ok: 'ok', bad: 'blocked', off: 'unknown' }
    const moderator = { review: vi.fn(async (data: Buffer) => verdicts[data.subarray(12).toString()]!) }
    const pool = fileStickerPool(dir, { moderator })
    await pool.save('aaaaaaaaaaaaaaaa', webp('ok'))
    await pool.save('bbbbbbbbbbbbbbbb', webp('bad'))
    await pool.save('cccccccccccccccc', webp('off'))
    expect(await readdir(join(dir, COLLECTED_DIR))).toEqual(expect.arrayContaining(['aaaaaaaaaaaaaaaa.webp']))
    expect((await readdir(join(dir, COLLECTED_DIR))).filter((f) => f.endsWith('.webp'))).toEqual(['aaaaaaaaaaaaaaaa.webp'])

    // Estoque antigo (coletado antes do filtro): a revisão decide.
    for (const [id, tag] of [['dddddddddddddddd', 'ok'], ['eeeeeeeeeeeeeeee', 'bad'], ['ffffffffffffffff', 'off']]) {
      await writeFile(join(dir, COLLECTED_DIR, `${id}.webp`), webp(tag!))
    }
    expect(await pool.reviewPending()).toEqual({ approved: 1, blocked: 1, unknown: 1 })
    const files = (await readdir(join(dir, COLLECTED_DIR))).filter((f) => f.endsWith('.webp')).sort()
    expect(files).toEqual(['aaaaaaaaaaaaaaaa.webp', 'dddddddddddddddd.webp', 'ffffffffffffffff.webp'])
    expect(await readdir(join(dir, COLLECTED_DIR, BLOCKED_DIR))).toEqual(['eeeeeeeeeeeeeeee.webp']) // separada, não apagada
    const picks = new Set<string | undefined>()
    for (let i = 0; i < 20; i++) picks.add(await pool.pick(() => i / 20))
    expect([...picks].sort()).toEqual([join(dir, COLLECTED_DIR, 'aaaaaaaaaaaaaaaa.webp'), join(dir, COLLECTED_DIR, 'dddddddddddddddd.webp')].sort())
    moderator.review.mockClear()
    await pool.reviewPending() // aprovadas não são revisadas de novo; a sem veredito tenta outra vez
    expect(moderator.review).toHaveBeenCalledTimes(1)
    moderator.review.mockClear()
    await pool.save('bbbbbbbbbbbbbbbb', webp('bad')) // reprovada repostada no grupo: não vai para a IA de novo
    await pool.save('eeeeeeeeeeeeeeee', webp('bad'))
    expect(moderator.review).not.toHaveBeenCalled()
  })
})
