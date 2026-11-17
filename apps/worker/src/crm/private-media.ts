// Resolve blob privado imediatamente antes do socket. A fila continua guardando
// somente a referencia, sem bytes, URL publica, credenciais ou caminho de disco.
import { createHash } from 'node:crypto'
import type { OutgoingContent, WaTransport } from '@wsm/core'

const KINDS = ['image', 'audio', 'document', 'video', 'sticker'] as const
const MAX_BYTES = 30 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export function privateCrmMediaResolver(opts: { baseUrl: string; token: string; fetch?: typeof fetch }) {
  const base = new URL(opts.baseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid private CRM origin')
  const endpoint = new URL('/internal/wa-media', base)
  const request = opts.fetch ?? fetch
  const reference = (sessionId: string, content: OutgoingContent) => {
    const c = content as Record<string, unknown>
    const kind = KINDS.find(k => typeof (c[k] as { url?: unknown })?.url === 'string' && ((c[k] as { url: string }).url.startsWith('blob:')))
    if (!kind) return null
    const url = (c[kind] as { url: string }).url
    const sha = /^blob:([a-f0-9]{64})$/.exec(url)?.[1]
    if (!sha || !UUID.test(sessionId) || !opts.token) throw new Error('CRM_PRIVATE_MEDIA_INVALID_REFERENCE')
    return { kind, sha, c }
  }
  const fetchMedia = async (sessionId: string, sha: string, metadataOnly = false) => {
    let response: Response
    try {
      response = await request(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { authorization: 'Bearer ' + opts.token, 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, sha256: sha, ...(metadataOnly ? { metadata_only: true } : {}) }) })
    } catch { throw new Error('CRM_PRIVATE_MEDIA_UNAVAILABLE') }
    if (!response.ok || !response.body) throw new Error('CRM_PRIVATE_MEDIA_UNAVAILABLE')
    return response
  }
  const resolve = async (sessionId: string, content: OutgoingContent): Promise<OutgoingContent> => {
    const ref = reference(sessionId, content)
    if (!ref) return content
    const { kind, sha, c } = ref
    const response = await fetchMedia(sessionId, sha)
    const length = Number(response.headers.get('content-length') ?? '0')
    if (!Number.isFinite(length) || length > MAX_BYTES) { await response.body.cancel(); throw new Error('CRM_PRIVATE_MEDIA_TOO_LARGE') }
    const reader = response.body.getReader(), chunks: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > MAX_BYTES) throw new Error('CRM_PRIVATE_MEDIA_TOO_LARGE')
        chunks.push(Buffer.from(part.value))
      }
    } catch { await reader.cancel().catch(() => undefined); throw new Error('CRM_PRIVATE_MEDIA_READ_FAILED') }
    const bytes = Buffer.concat(chunks)
    if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('CRM_PRIVATE_MEDIA_INTEGRITY')
    // Baileys aceita Buffer nos campos image/audio/document/video/sticker.
    // O cast fica na fronteira de transporte; nada binario volta ao registro da fila.
    const mime = response.headers.get('content-type')
    return { ...c, [kind]: bytes, ...(mime ? { mimetype: mime } : {}) } as unknown as OutgoingContent
  }
  return Object.assign(resolve, { preflight: async (sessionId: string, content: OutgoingContent) => {
    const ref = reference(sessionId, content)
    if (!ref) return
    const response = await fetchMedia(sessionId, ref.sha, true)
    const meta = await response.json() as { sha256?: unknown; size?: unknown }
    if (meta.sha256 !== ref.sha || typeof meta.size !== 'number' || meta.size <= 0 || meta.size > MAX_BYTES) throw new Error('CRM_PRIVATE_MEDIA_INVALID_METADATA')
  } })
}

export function attachPrivateCrmMedia(t: WaTransport, sessionId: string, resolve: ReturnType<typeof privateCrmMediaResolver>): void {
  const send = t.sendMessage.bind(t)
  t.sendMessage = async (to, content) => send(to, await resolve(sessionId, content))
}
