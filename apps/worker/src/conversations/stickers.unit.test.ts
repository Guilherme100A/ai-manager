import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COLLECTED_DIR, fileStickerPool } from './stickers'

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
  it('só guarda webp de verdade, sem repetir, e mantém as mais recentes', async () => {
    const dir = await temp()
    const pool = fileStickerPool(dir, 2)
    await pool.save('aaaaaaaaaaaaaaaa', Buffer.from('não é webp'))
    await pool.save('../fora', webp('x'))
    expect(await readdir(dir)).toEqual([])
    await pool.save('aaaaaaaaaaaaaaaa', webp('1'))
    await pool.save('aaaaaaaaaaaaaaaa', webp('1')) // repetida: ignora
    await utimes(join(dir, COLLECTED_DIR, 'aaaaaaaaaaaaaaaa.webp'), new Date(1_000), new Date(1_000))
    await pool.save('bbbbbbbbbbbbbbbb', webp('2'))
    await pool.save('cccccccccccccccc', webp('3'))
    expect((await readdir(join(dir, COLLECTED_DIR))).sort()).toEqual(['bbbbbbbbbbbbbbbb.webp', 'cccccccccccccccc.webp'])
  })
})
