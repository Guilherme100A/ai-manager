import JSZip from 'jszip'
import type { SpyMediaKind } from '@wsm/db'

export interface ImportedFlowMedia {
  branch: string | null
  kind: SpyMediaKind
  mime: string
  fileName: string
  bytes: Buffer
}

export interface ImportedSpyFlow {
  title: string
  phone: string | null
  script: string
  summary: string | null
  conversations: Array<{ fileName: string; content: string }>
  media: ImportedFlowMedia[]
}

const MAX_FILE = 32 * 1024 * 1024
const MAX_TOTAL = 64 * 1024 * 1024

/** Lê o ZIP gerado pelo Espião. Conversas ficam em texto; mídias preservam os bytes originais. */
export async function parseSpyFlowZip(data: ArrayBuffer, fallbackTitle = 'Fluxo importado'): Promise<ImportedSpyFlow> {
  if (data.byteLength > MAX_TOTAL) throw new Error('ZIP maior que 64 MB')
  const zip = await JSZip.loadAsync(data)
  const script = await text(zip, 'roteiro.txt')
  if (!script?.trim()) throw new Error('ZIP inválido: roteiro.txt não encontrado')
  const summary = await text(zip, 'resumo.md')
  const identity = `${script}\n${summary ?? ''}`
  const phone = /wa\.me\/(\d{8,20})/i.exec(identity)?.[1] ?? null
  const title = (/^Funil de (.+?) \(wa\.me\//im.exec(script)?.[1]
    ?? /^#\s+(.+?)\s+[—-]\s+wa\.me\//im.exec(summary ?? '')?.[1]
    ?? fallbackTitle).trim().slice(0, 120)

  const conversations: ImportedSpyFlow['conversations'] = []
  const media: ImportedFlowMedia[] = []
  let total = 0
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const path = safePath(entry.name)
    if (/^conversa-.+\.md$/i.test(path)) {
      conversations.push({ fileName: path, content: await entry.async('string') })
      continue
    }
    if (!path.startsWith('midias/')) continue
    const bytes = Buffer.from(await entry.async('uint8array'))
    total += bytes.byteLength
    if (bytes.byteLength > MAX_FILE) throw new Error(`${path}: arquivo maior que 32 MB`)
    if (total > MAX_TOTAL) throw new Error('Mídias descompactadas maiores que 64 MB')
    const parts = path.split('/')
    const rawName = parts.at(-1) ?? 'arquivo'
    const fileName = rawName.replace(/^\d+-/, '').slice(0, 255)
    const mime = mimeFor(fileName)
    media.push({ branch: parts.length > 2 ? parts[1] ?? null : null, kind: kindFor(mime), mime, fileName, bytes })
  }
  return { title, phone, script: script.trim(), summary: summary?.trim() || null, conversations, media }
}

async function text(zip: JSZip, name: string): Promise<string | null> {
  const entry = zip.file(name)
  return entry ? entry.async('string') : null
}

function safePath(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.split('/').includes('..')) throw new Error('ZIP inválido: caminho inseguro')
  return normalized
}

function mimeFor(name: string): string {
  const n = name.toLowerCase()
  if (n.endsWith('.pdf')) return 'application/pdf'
  if (n.endsWith('.png')) return 'image/png'
  if (n.endsWith('.webp')) return 'image/webp'
  if (n.endsWith('.gif')) return 'image/gif'
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
  if (n.endsWith('.ogg') || n.endsWith('.opus')) return 'audio/ogg'
  if (n.endsWith('.wav')) return 'audio/wav'
  if (n.endsWith('.m4a') || n.endsWith('.aac')) return 'audio/mp4'
  if (n.endsWith('.mp3')) return 'audio/mpeg'
  if (n.endsWith('.webm')) return 'video/webm'
  if (n.endsWith('.mp4')) return 'video/mp4'
  return 'application/octet-stream'
}

function kindFor(mime: string): SpyMediaKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}
