// Extração pura (sem rede) do Espião: anúncios da Biblioteca, números de WhatsApp, tipo de link e resultados da busca.

export interface LibraryAd {
  adArchiveId: string
  pageId?: string
  pageName?: string
  /** Segmento do perfil na URL (`61577928417447` ou um apelido), que é o que os buscadores indexam. */
  profileToken?: string
  profileUri?: string
  ctaType?: string
  linkUrl?: string
  title?: string
  body?: string
  displayFormat?: string
  startDate?: number
  images: string[]
  videos: string[]
}

export type SpyInput =
  | { kind: 'whatsapp'; phone: string }
  | { kind: 'ad'; adArchiveId: string; url: string }
  | { kind: 'search'; url: string }
  | { kind: 'post'; url: string }
  | { kind: 'invalid'; reason: string }

/** Número de exemplo que o próprio Facebook coloca em anúncios de teste/placeholder. */
const PLACEHOLDER_PHONES = new Set(['16505555555', '15555555555'])

export function normalizePhone(raw: string): string | undefined {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return undefined
  if (PLACEHOLDER_PHONES.has(digits)) return undefined
  return digits
}

const WA_LINK = /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?(?:[^"'\s]*?&)?phone=|whatsapp:\/\/send\?(?:[^"'\s]*?&)?phone=)\+?(\d{10,15})/gi

/** Números que aparecem em links do WhatsApp (wa.me, api.whatsapp.com/send?phone=, whatsapp://). */
export function whatsappLinkPhones(text: string): string[] {
  const out = new Set<string>()
  for (const m of decodeLoose(text).matchAll(WA_LINK)) {
    const phone = normalizePhone(m[1]!)
    if (phone) out.add(phone)
  }
  return [...out]
}

/**
 * Número do botão de WhatsApp de um post/vídeo aberto sem login: o link do botão leva `source=FB_Post`.
 * Sem esse marcador, cai para qualquer link de WhatsApp da página.
 */
export function postButtonPhone(html: string): string | undefined {
  const text = decodeLoose(html)
  for (const m of text.matchAll(/send\/?\?phone=(\d{10,15})[^"'\s]{0,80}?source=FB_Post/g)) {
    const phone = normalizePhone(m[1]!)
    if (phone) return phone
  }
  return whatsappLinkPhones(text)[0]
}

/** Número em texto livre (anúncio, página Sobre): link do WhatsApp ou "+DD ..." internacional. */
export function textPhone(text: string): string | undefined {
  const viaLink = whatsappLinkPhones(text)[0]
  if (viaLink) return viaLink
  for (const m of decodeLoose(text).matchAll(/\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{3,5}[\s.-]?\d{4}\b/g)) {
    const phone = normalizePhone(m[0])
    if (phone) return phone
  }
  return undefined
}

/**
 * WhatsApp da página "Sobre → Contato": o campo `field_type: whatsapp` ou o link do botão (`send?phone=…&token=`).
 * Só desses dois lugares: o HTML da página tem outros telefones (sugestões, rodapé) que não são do anunciante.
 */
export function aboutPagePhone(html: string): string | undefined {
  const text = decodeLoose(html)
  for (const m of text.matchAll(/"text":"(\+?[\d\s().-]{8,25})"\},"field_type":"whatsapp/g)) {
    const phone = normalizePhone(m[1]!)
    if (phone) return phone
  }
  const section = text.indexOf('"field_section_type":"about_contact_info"')
  if (section < 0) return undefined
  for (const m of text.slice(section, section + 20_000).matchAll(/api\.whatsapp\.com\/send\/?\?phone=(\d{10,15})&token=/g)) {
    const phone = normalizePhone(m[1]!)
    if (phone) return phone
  }
  return undefined
}

export function classifyInput(raw: string): SpyInput {
  const text = raw.trim()
  if (!text) return { kind: 'invalid', reason: 'link vazio' }
  const direct = whatsappLinkPhones(text)[0]
  if (direct) return { kind: 'whatsapp', phone: direct }
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return { kind: 'invalid', reason: 'não é um link' }
  }
  const host = url.hostname.replace(/^(www|m|web|mbasic)\./, '')
  if (host !== 'facebook.com' && host !== 'fb.com') return { kind: 'invalid', reason: 'só links do Facebook ou do WhatsApp' }
  url.hostname = 'www.facebook.com'
  url.protocol = 'https:'
  if (url.pathname.startsWith('/ads/library')) {
    const id = url.searchParams.get('id')
    if (id && /^\d+$/.test(id)) return { kind: 'ad', adArchiveId: id, url: `https://www.facebook.com/ads/library/?id=${id}` }
    if (url.searchParams.get('q') || url.searchParams.get('view_all_page_id')) return { kind: 'search', url: url.href }
    return { kind: 'invalid', reason: 'link da Biblioteca sem anúncio nem busca' }
  }
  if (/\/(posts|videos|reel|permalink\.php|story\.php|watch|photo)/.test(url.pathname) || url.searchParams.get('story_fbid')) return { kind: 'post', url: url.href }
  return { kind: 'invalid', reason: 'link do Facebook que não é anúncio nem post' }
}

/** Anúncios embutidos no HTML da Biblioteca (busca ou `?id=`). Cada anúncio vai de um `ad_archive_id` ao próximo. */
export function parseLibraryAds(html: string): LibraryAd[] {
  const ads: LibraryAd[] = []
  const seen = new Set<string>()
  const starts = [...html.matchAll(/"ad_archive_id":"(\d+)"/g)]
  starts.forEach((m, i) => {
    const id = m[1]!
    if (seen.has(id)) return
    seen.add(id)
    const end = starts.slice(i + 1).find((n) => n[1] !== id)?.index ?? m.index + 30_000
    const chunk = html.slice(m.index, end)
    const str = (key: string) => {
      const raw = chunk.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1]
      return raw === undefined ? undefined : unescapeJson(raw)
    }
    const profileUri = str('page_profile_uri')
    const bodies = [...chunk.matchAll(/"body":\{"text":"((?:[^"\\]|\\.)*)"/g)].map((b) => unescapeJson(b[1]!))
    const start = chunk.match(/"start_date":(\d+)/)?.[1]
    ads.push({
      adArchiveId: id,
      pageId: str('page_id'),
      pageName: str('page_name'),
      profileUri,
      profileToken: profileUri ? profileToken(profileUri) : undefined,
      ctaType: str('cta_type'),
      linkUrl: str('link_url'),
      title: str('title'),
      body: bodies[0] ?? undefined,
      displayFormat: str('display_format'),
      startDate: start ? Number(start) : undefined,
      images: unique([...chunk.matchAll(/"(?:original_image_url|resized_image_url|video_preview_image_url)":"([^"]+)"/g)].map((x) => unescapeJson(x[1]!))).slice(0, 5),
      videos: unique([...chunk.matchAll(/"video_(?:hd|sd)_url":"([^"]+)"/g)].map((x) => unescapeJson(x[1]!))).slice(0, 2),
    })
  })
  return ads
}

/** Anúncio que manda para o WhatsApp (botão ou destino). */
export function isWhatsappAd(ad: LibraryAd): boolean {
  return /WHATSAPP/.test(ad.ctaType ?? '') || /whatsapp\.com|wa\.me/i.test(ad.linkUrl ?? '')
}

export function profileToken(uri: string): string | undefined {
  try {
    const url = new URL(uri)
    const id = url.searchParams.get('id')
    if (id) return id
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'people') return parts[2]
    return parts[0]
  } catch {
    return undefined
  }
}

/**
 * Dos links de resultado da busca, só os posts/vídeos do próprio perfil. Posts primeiro: abrem com o botão do
 * WhatsApp tanto direto quanto pelo proxy; a página de vídeo pelo proxy esconde o botão.
 */
export function profilePostLinks(results: string[], token: string): string[] {
  const urls = new Set<string>()
  for (const raw of results) {
    const url = raw.replace(/&amp;/g, '&')
    if (!/^https:\/\/(www\.|m\.|web\.)?facebook\.com\//.test(url)) continue
    const path = url.replace(/^https:\/\/[^/]+/, '')
    const ownProfile = path.toLowerCase().startsWith(`/${token.toLowerCase()}/`) || new RegExp(`[?&]id=${token}(?:&|$)`).test(path)
    if (!ownProfile || !/\/(posts|videos|reel)\/|story_fbid=/.test(path)) continue
    urls.add(url.replace(/^https:\/\/(m|web)\./, 'https://www.'))
  }
  return [...urls].sort((a, b) => Number(!/\/posts\//.test(a)) - Number(!/\/posts\//.test(b)))
}

function unescapeJson(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

function decodeLoose(text: string): string {
  return text.replace(/\\\//g, '/').replace(/\\u0025/g, '%').replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/%2F/gi, '/').replace(/%3F/gi, '?').replace(/%3D/gi, '=').replace(/%26/gi, '&').replace(/%3A/gi, ':')
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}
