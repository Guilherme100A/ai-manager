// Figurinhas do aquecimento: arquivos .webp da pasta (colocados por você) + as recebidas pelos chips, guardadas em
// <pasta>/coletadas. Enviadas como figurinha nativa do WhatsApp. Pasta vazia ou ausente: simplesmente não manda.
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const COLLECTED_DIR = 'coletadas'
export const MAX_COLLECTED = 300

export interface StickerPool {
  /** Caminho de uma figurinha sorteada, ou undefined se não houver nenhuma. */
  pick(random: () => number): Promise<string | undefined>
  save(id: string, data: Buffer): Promise<void>
}

async function webps(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.webp')).map((f) => join(dir, f))
  } catch {
    return []
  }
}

export function fileStickerPool(dir: string, maxCollected = MAX_COLLECTED): StickerPool {
  const collected = join(dir, COLLECTED_DIR)
  return {
    async pick(random) {
      const all = [...(await webps(dir)), ...(await webps(collected))]
      return all.length ? all[Math.floor(random() * all.length)] : undefined
    },
    async save(id, data) {
      // Figurinha do WhatsApp é webp: confere a assinatura RIFF....WEBP antes de guardar.
      if (!/^[a-f0-9]{8,64}$/.test(id) || data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return
      await mkdir(collected, { recursive: true })
      const file = join(collected, `${id}.webp`)
      await writeFile(file, data, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err })
      // Mantém só as mais recentes.
      const files = await webps(collected)
      if (files.length <= maxCollected) return
      const dated = await Promise.all(files.map(async (f) => ({ f, at: (await stat(f)).mtimeMs })))
      dated.sort((a, b) => a.at - b.at)
      await Promise.all(dated.slice(0, files.length - maxCollected).map(({ f }) => unlink(f).catch(() => undefined)))
    },
  }
}
