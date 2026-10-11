// Figurinhas do aquecimento: arquivos .webp da pasta (colocados por você) + as recebidas pelos chips, guardadas em
// <pasta>/coletadas. Enviadas como figurinha nativa do WhatsApp. Pasta vazia ou ausente: simplesmente não manda.
// As coletadas passam pelo filtro (StickerModerator) antes de entrar no sorteio; impróprias vão para <coletadas>/bloqueadas. Com o
// estoque cheio (MAX_COLLECTED), novas figurinhas recebidas deixam de ser guardadas.
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { StickerModerator } from '@wsm/core'

export const COLLECTED_DIR = 'coletadas'
export const MAX_COLLECTED = 300
/** Reprovadas pelo filtro ficam aqui (fora do sorteio) para você conferir; pode apagar a pasta quando quiser. */
export const BLOCKED_DIR = 'bloqueadas'
/** Lista (um arquivo por linha) das coletadas já aprovadas pelo filtro. */
export const APPROVED_LIST = '.aprovadas'
/** Reprovadas: a mesma figurinha repostada nos grupos não volta para a IA (nem custa de novo). */
export const BLOCKED_LIST = '.bloqueadas'

export interface StickerPool {
  /** Caminho de uma figurinha sorteada, ou undefined se não houver nenhuma. */
  pick(random: () => number): Promise<string | undefined>
  save(id: string, data: Buffer): Promise<void>
}

export interface FileStickerPoolOptions {
  maxCollected?: number
  /** Sem filtro, as coletadas entram direto no sorteio (testes / IA não configurada no boot). */
  moderator?: StickerModerator
  logger?: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }
}

export interface FileStickerPool extends StickerPool {
  /** Revisa as coletadas ainda não aprovadas: impróprias vão para bloqueadas/; sem veredito ficam fora do sorteio. */
  reviewPending(): Promise<{ approved: number; blocked: number; unknown: number }>
}

async function webps(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.webp')).map((f) => join(dir, f))
  } catch {
    return []
  }
}

const isWebp = (data: Buffer) => data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'

export function fileStickerPool(dir: string, opts: FileStickerPoolOptions = {}): FileStickerPool {
  const maxCollected = opts.maxCollected ?? MAX_COLLECTED
  const collected = join(dir, COLLECTED_DIR)
  const listFile = join(collected, APPROVED_LIST)
  const saving = new Set<string>()

  const blockedFile = join(collected, BLOCKED_LIST)
  const readList = async (file: string): Promise<Set<string>> => {
    try {
      return new Set((await readFile(file, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean))
    } catch {
      return new Set()
    }
  }
  const approvedNames = () => readList(listFile)
  const markApproved = (file: string) => appendFile(listFile, `${basename(file)}\n`)
  const markBlocked = async (file: string) => {
    await mkdir(collected, { recursive: true })
    await appendFile(blockedFile, `${basename(file)}\n`)
  }

  return {
    async pick(random) {
      let usable = await webps(collected)
      if (opts.moderator) {
        const approved = await approvedNames()
        usable = usable.filter((f) => approved.has(basename(f)))
      }
      const all = [...(await webps(dir)), ...usable]
      return all.length ? all[Math.floor(random() * all.length)] : undefined
    },
    async save(id, data) {
      // Figurinha do WhatsApp é webp: confere a assinatura RIFF....WEBP antes de guardar.
      if (!/^[a-f0-9]{8,64}$/.test(id) || !isWebp(data) || saving.has(id)) return
      const file = join(collected, `${id}.webp`)
      // Estoque cheio: para de coletar (não troca as antigas, que já passaram pelo filtro).
      const existing = await webps(collected)
      if (existing.length >= maxCollected || existing.includes(file)) return
      if (opts.moderator && (await readList(blockedFile)).has(basename(file))) return
      saving.add(id)
      try {
        if (opts.moderator) {
          const verdict = await opts.moderator.review(data)
          if (verdict === 'blocked') await markBlocked(file)
          if (verdict !== 'ok') {
            opts.logger?.info({ sticker: id, verdict }, 'sticker not collected')
            return
          }
        }
        await mkdir(collected, { recursive: true })
        await writeFile(file, data, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err })
        if (opts.moderator) await markApproved(file)
      } finally {
        saving.delete(id)
      }
    },
    async reviewPending() {
      const counts = { approved: 0, blocked: 0, unknown: 0 }
      if (!opts.moderator) return counts
      const approved = await approvedNames()
      for (const file of await webps(collected)) {
        if (approved.has(basename(file))) continue
        const data = await readFile(file).catch(() => undefined)
        const verdict = data ? await opts.moderator.review(data) : 'blocked'
        if (verdict === 'ok') {
          await markApproved(file)
          counts.approved++
        } else if (verdict === 'blocked') {
          await mkdir(join(collected, BLOCKED_DIR), { recursive: true })
          await rename(file, join(collected, BLOCKED_DIR, basename(file))).catch(() => undefined)
          await markBlocked(file)
          counts.blocked++
        } else {
          counts.unknown++
        }
      }
      opts.logger?.info(counts, 'collected stickers reviewed')
      return counts
    },
  }
}
