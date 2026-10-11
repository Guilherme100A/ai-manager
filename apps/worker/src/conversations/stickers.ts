// Figurinhas do aquecimento: arquivos .webp da pasta (colocados por você) + as recebidas pelos chips, guardadas em
// <pasta>/coletadas. Enviadas como figurinha nativa do WhatsApp. Pasta vazia ou ausente: simplesmente não manda.
//
// Filtro das recebidas, sem API externa:
// 1. na chegada: figurinha de grupo com nome suspeito (hot, +18, ...) é descartada sem nem baixar;
// 2. em lote: as demais esperam em <coletadas>/pendentes e o NSFWJS avalia de hora em hora (o modelo só fica na
//    memória durante a avaliação). Reprovadas são apagadas e o id fica em .bloqueadas (repostada não volta).
// Estoque cheio (MAX_COLLECTED): apaga as ROTATE_BATCH mais antigas e continua, para sempre ter figurinhas novas.
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { StickerScorer, StickerSink, StickerSource } from '@wsm/core'

export const COLLECTED_DIR = 'coletadas'
export const PENDING_DIR = 'pendentes'
export const MAX_COLLECTED = 300
export const ROTATE_BATCH = 50
export const MAX_PENDING = 100
/** A partir desta probabilidade (Porn/Hentai/Sexy em qualquer quadro) a figurinha é reprovada. */
export const NSFW_THRESHOLD = 0.5
/** Ids reprovados: a mesma figurinha repostada não é avaliada de novo. */
export const BLOCKED_LIST = '.bloqueadas'
const BLOCKED_LIST_MAX = 5000
/** Palavras no nome do grupo que descartam a figurinha (sem acento, minúsculas). STICKER_BLOCKED_GROUP_WORDS troca. */
export const DEFAULT_BLOCKED_GROUP_WORDS = ['hot', '+18', '18+', 'nsfw', 'putaria', 'safad', 'nude', 'porn', 'xxx', 'onlyfans', 'privacy', 'sexy', '🔞']

export interface StickerPool extends StickerSink {
  /** Caminho de uma figurinha sorteada, ou undefined se não houver nenhuma. */
  pick(random: () => number): Promise<string | undefined>
}

export interface FileStickerPoolOptions {
  maxCollected?: number
  rotateBatch?: number
  maxPending?: number
  /** Sem avaliador, as recebidas (de grupos permitidos) entram direto no estoque. */
  scorer?: StickerScorer
  threshold?: number
  blockedGroupWords?: string[]
  logger?: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }
}

export interface FileStickerPool extends StickerPool {
  /** Avalia as pendentes: aprovadas entram no estoque (com rotação), reprovadas são apagadas. */
  processPending(): Promise<{ approved: number; blocked: number; failed: number }>
}

async function webps(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.webp')).map((f) => join(dir, f))
  } catch {
    return []
  }
}

const isWebp = (data: Buffer) => data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
/** Minúsculas, sem acento e com letras "estilizadas" (𝐇𝐎𝐓, ⓗⓞⓣ) normalizadas. */
const normalizeName = (name: string) => name.normalize('NFKC').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function fileStickerPool(dir: string, opts: FileStickerPoolOptions = {}): FileStickerPool {
  const maxCollected = opts.maxCollected ?? MAX_COLLECTED
  const rotateBatch = Math.max(1, Math.min(opts.rotateBatch ?? ROTATE_BATCH, maxCollected))
  const maxPending = opts.maxPending ?? MAX_PENDING
  const threshold = opts.threshold ?? NSFW_THRESHOLD
  const words = (opts.blockedGroupWords ?? DEFAULT_BLOCKED_GROUP_WORDS).map(normalizeName).filter(Boolean)
  const collected = join(dir, COLLECTED_DIR)
  const pending = join(collected, PENDING_DIR)
  const blockedFile = join(collected, BLOCKED_LIST)
  const saving = new Set<string>()
  let blockedCache: Set<string> | undefined

  const blocked = async (): Promise<Set<string>> => {
    if (blockedCache) return blockedCache
    try {
      blockedCache = new Set((await readFile(blockedFile, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean))
    } catch {
      blockedCache = new Set()
    }
    return blockedCache
  }
  const markBlocked = async (id: string) => {
    const set = await blocked()
    set.add(id)
    await mkdir(collected, { recursive: true })
    await appendFile(blockedFile, `${id}\n`)
    if (set.size > BLOCKED_LIST_MAX) {
      const keep = [...set].slice(-BLOCKED_LIST_MAX)
      blockedCache = new Set(keep)
      await writeFile(blockedFile, `${keep.join('\n')}\n`)
    }
  }
  const groupBlocked = (source?: StickerSource) => {
    if (!source?.groupName) return false
    const name = normalizeName(source.groupName)
    return words.some((w) => name.includes(w))
  }

  /** Abre vaga no estoque: cheio → apaga as `rotateBatch` mais antigas. */
  const rotate = async () => {
    const files = await webps(collected)
    if (files.length < maxCollected) return
    const dated = await Promise.all(files.map(async (f) => ({ f, at: (await stat(f).catch(() => undefined))?.mtimeMs ?? 0 })))
    dated.sort((a, b) => a.at - b.at)
    const drop = dated.slice(0, Math.max(rotateBatch, files.length - maxCollected + 1))
    await Promise.all(drop.map(({ f }) => unlink(f).catch(() => undefined)))
    opts.logger?.info({ removed: drop.length }, 'sticker stock rotated')
  }

  return {
    async pick(random) {
      const all = [...(await webps(dir)), ...(await webps(collected))]
      return all.length ? all[Math.floor(random() * all.length)] : undefined
    },
    accepts(id, source) {
      if (!groupBlocked(source)) return true
      opts.logger?.info({ sticker: id, group: source.groupName }, 'sticker ignored: blocked group')
      return false
    },
    async save(id, data, source) {
      // Figurinha do WhatsApp é webp: confere a assinatura RIFF....WEBP antes de guardar.
      if (!/^[a-f0-9]{8,64}$/.test(id) || !isWebp(data) || saving.has(id) || groupBlocked(source)) return
      const name = `${id}.webp`
      if ((await blocked()).has(name)) return
      if ((await webps(collected)).includes(join(collected, name))) return
      saving.add(id)
      try {
        if (opts.scorer) {
          const queued = await webps(pending)
          if (queued.length >= maxPending || queued.includes(join(pending, name))) return
          await mkdir(pending, { recursive: true })
          await writeFile(join(pending, name), data, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err })
          return
        }
        await rotate()
        await mkdir(collected, { recursive: true })
        await writeFile(join(collected, name), data, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err })
      } finally {
        saving.delete(id)
      }
    },
    async processPending() {
      const counts = { approved: 0, blocked: 0, failed: 0 }
      const queued = await webps(pending)
      if (!opts.scorer || !queued.length) return counts
      try {
        await opts.scorer.ready()
      } catch (err) {
        // Modelo não carregou: as pendentes ficam para a próxima rodada.
        opts.logger?.warn({ pending: queued.length, err: err instanceof Error ? err.message : String(err) }, 'sticker model unavailable')
        await opts.scorer.release().catch(() => undefined)
        return counts
      }
      try {
        for (const file of queued) {
          const name = basename(file)
          let score: number
          try {
            score = await opts.scorer.score(await readFile(file))
          } catch (err) {
            // Não abre como imagem (ou o modelo falhou nela): descarta, sem bloquear o id.
            await unlink(file).catch(() => undefined)
            counts.failed++
            opts.logger?.warn({ sticker: name, err: err instanceof Error ? err.message : String(err) }, 'sticker score failed')
            continue
          }
          if (score >= threshold) {
            await unlink(file).catch(() => undefined)
            await markBlocked(name)
            counts.blocked++
            continue
          }
          await rotate()
          await rename(file, join(collected, name)).catch(() => unlink(file).catch(() => undefined))
          counts.approved++
        }
      } finally {
        await opts.scorer.release().catch(() => undefined)
      }
      opts.logger?.info(counts, 'pending stickers processed')
      return counts
    },
  }
}
