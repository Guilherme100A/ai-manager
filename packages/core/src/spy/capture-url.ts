import { classifyInput, normalizePhone } from './parse'

export class SpyCaptureError extends Error {
  constructor(readonly code: 'INVALID_URL' | 'LEGACY_CAPTURE' | 'NOT_FOUND') {
    super({ INVALID_URL: 'Use um link válido de anúncio/post do Facebook ou de número do WhatsApp', LEGACY_CAPTURE: 'Link já cadastrado fora da captura manual; consulte as ofertas existentes', NOT_FOUND: 'Captura não encontrada' }[code])
    this.name = 'SpyCaptureError'
  }
}

/** Somente destinos públicos suportados. Descarta texto, tokens e tracking antes de persistir ou buscar. */
export function canonicalSpyCaptureUrl(raw: string): string {
  if (!raw.trim() || raw.length > 2048) throw new SpyCaptureError('INVALID_URL')
  let url: URL
  try { url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`) }
  catch { throw new SpyCaptureError('INVALID_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new SpyCaptureError('INVALID_URL')
  const host = url.hostname.toLowerCase()
  if (host === 'wa.me' || ['api.whatsapp.com', 'web.whatsapp.com', 'whatsapp.com', 'www.whatsapp.com'].includes(host)) {
    const number = host === 'wa.me' ? /^\/(\+?\d{10,15})\/?$/.exec(url.pathname)?.[1]
      : /^\/send\/?$/.test(url.pathname) && url.searchParams.getAll('phone').length === 1 ? url.searchParams.get('phone')?.trim() : undefined
    const phone = number && /^\+?\d{10,15}$/.test(number) ? normalizePhone(number) : undefined
    if (!phone) throw new SpyCaptureError('INVALID_URL')
    return `https://wa.me/${phone}`
  }
  if (!['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'mbasic.facebook.com', 'fb.com', 'www.fb.com'].includes(host)) throw new SpyCaptureError('INVALID_URL')
  const safe = new URL(`https://www.facebook.com${url.pathname.replace(/\/+$/, '') || '/'}`)
  const keys = safe.pathname.startsWith('/ads/library')
    ? ['id', 'q', 'view_all_page_id', 'country', 'active_status', 'ad_type', 'search_type']
    : ['id', 'story_fbid', 'v', 'fbid', 'set']
  for (const key of keys) {
    const values = url.searchParams.getAll(key)
    if (values.length > 1) throw new SpyCaptureError('INVALID_URL')
    if (values[0]) safe.searchParams.set(key, values[0])
  }
  safe.searchParams.sort()
  const input = classifyInput(safe.href)
  if (!['ad', 'post', 'search'].includes(input.kind)) throw new SpyCaptureError('INVALID_URL')
  return input.kind === 'ad' ? input.url : safe.href
}
