// Busca do número do WhatsApp de um anúncio, em cascata e sem login:
// 1. destino do anúncio (wa.me / send?phone=)  2. texto do anúncio
// 3. posts/vídeos do perfil achados no buscador → botão do WhatsApp do post (source=FB_Post)
// 4. página "Sobre" do perfil.
import type { SpyFoundVia } from '@wsm/db'
import type { SpyHttp } from './http'
import { aboutPagePhone, isWhatsappAd, parseLibraryAds, postButtonPhone, profilePostLinks, textPhone, whatsappLinkPhones, type LibraryAd } from './parse'

export interface FindResult {
  phone?: string
  foundVia?: SpyFoundVia
  evidenceUrl?: string
  /** Por que não achou (quando `phone` vem vazio). */
  reason?: string
  /** Posts/vídeos abertos na etapa 3. */
  candidates: string[]
  /** A busca dos posts não aconteceu (buscador bloqueou ou caiu): vale tentar de novo mais tarde. */
  searchBlocked?: boolean
}

export interface SpyFinderOptions {
  /** Quantos posts/vídeos do buscador abrir por anúncio. */
  maxCandidates?: number
  /** Quantos anúncios uma busca da Biblioteca pode gerar. */
  maxSearchAds?: number
}

export class SpyFinder {
  private readonly maxCandidates: number
  readonly maxSearchAds: number

  constructor(private readonly http: SpyHttp, options: SpyFinderOptions = {}) {
    this.maxCandidates = options.maxCandidates ?? 4
    this.maxSearchAds = options.maxSearchAds ?? 30
  }

  async loadAd(adArchiveId: string): Promise<LibraryAd> {
    const page = await this.http.facebook(`https://www.facebook.com/ads/library/?id=${adArchiveId}`)
    const ad = parseLibraryAds(page.text).find((a) => a.adArchiveId === adArchiveId)
    if (!ad) throw new Error(`anúncio ${adArchiveId} não apareceu na Biblioteca (HTTP ${page.status})`)
    return ad
  }

  /** Anúncios de WhatsApp de uma busca da Biblioteca, sem repetir página+criativo. */
  async searchAds(url: string): Promise<LibraryAd[]> {
    const page = await this.http.facebook(url)
    const ads = parseLibraryAds(page.text)
    if (ads.length === 0) throw new Error(`a busca não trouxe anúncios (HTTP ${page.status})`)
    return ads.filter(isWhatsappAd).slice(0, this.maxSearchAds)
  }

  async findForAd(ad: LibraryAd): Promise<FindResult> {
    const fromLink = whatsappLinkPhones(ad.linkUrl ?? '')[0]
    if (fromLink) return { phone: fromLink, foundVia: 'link', evidenceUrl: ad.linkUrl, candidates: [] }
    const fromText = textPhone(`${ad.title ?? ''}\n${ad.body ?? ''}`)
    if (fromText) return { phone: fromText, foundVia: 'texto', candidates: [] }

    const candidates: string[] = []
    let blocked = false
    let loginWall = false
    const tokens = [...new Set([ad.profileToken, ad.pageId].filter((t): t is string => Boolean(t)))]
    for (const token of tokens) {
      // Buscador fora do ar ou recusando o IP não derruba a cascata: segue para a página Sobre.
      const results = await this.http.search(`site:facebook.com ${token}`).catch(() => ({ blocked: true, urls: [] as string[] }))
      if (results.blocked) blocked = true
      for (const url of profilePostLinks(results.urls, token)) {
        if (candidates.length >= this.maxCandidates) break
        if (candidates.includes(url)) continue
        candidates.push(url)
        const hit = await this.openPost(url, token)
        if (hit.loginWall) loginWall = true
        if (hit.phone) return { phone: hit.phone, foundVia: 'post', evidenceUrl: hit.url, candidates }
      }
      if (candidates.length >= this.maxCandidates) break
    }

    if (ad.pageId) {
      const about = `https://www.facebook.com/profile.php?id=${ad.pageId}&sk=about_contact_and_basic_info`
      const phone = aboutPagePhone((await this.http.facebook(about)).text)
      if (phone) return { phone, foundVia: 'pagina', evidenceUrl: about, candidates }
    }
    const searchBlocked = blocked && candidates.length === 0
    return {
      reason: loginWall
        ? `a Facebook pediu login para abrir ${candidates.length} post(s) a partir deste servidor; configure um proxy residencial (SPY_PROXY_SESSION)`
        : candidates.length > 0
        ? `nenhum dos ${candidates.length} posts do perfil mostrou o WhatsApp sem login, e a página Sobre não tem número`
        : searchBlocked
          ? 'o buscador bloqueou a busca (anti-robô)'
          : 'o buscador não achou posts do perfil e a página Sobre não tem número',
      candidates,
      ...(searchBlocked ? { searchBlocked: true } : {}),
    }
  }

  async findForPost(url: string): Promise<FindResult> {
    const owner = new URL(url).pathname.split('/').filter(Boolean)[0] ?? ''
    const hit = await this.openPost(url, owner)
    if (hit.phone) return { phone: hit.phone, foundVia: 'post', evidenceUrl: hit.url, candidates: [url] }
    return {
      reason: hit.loginWall ? 'a Facebook pediu login para abrir o post a partir deste servidor; configure um proxy residencial (SPY_PROXY_SESSION)' : 'o post não tem botão de WhatsApp visível sem login',
      candidates: [url],
    }
  }

  /**
   * Abre o post pelo link direto e, sem número, pelo permalink (id do post/vídeo + id do perfil): dependendo do IP,
   * um dos dois cai no login ou esconde o botão (pelo proxy o /posts/ abre e o permalink pede login; sem proxy, o
   * /videos/ esconde o botão e o permalink mostra).
   */
  private async openPost(url: string, profile: string): Promise<{ phone?: string; url?: string; loginWall: boolean }> {
    let loginWall = false
    for (const target of [...new Set([url, permalinkFor(url, profile)].filter((u): u is string => Boolean(u)))]) {
      const page = await this.http.facebook(target)
      if (page.loginWall) loginWall = true
      const phone = postButtonPhone(page.text)
      if (phone) return { phone, url: target, loginWall }
    }
    return { loginWall }
  }
}

/** `permalink.php?story_fbid=<id do post/vídeo>&id=<perfil>` a partir de um link /posts|videos|reel/<id>. */
export function permalinkFor(url: string, profile: string): string | undefined {
  const parsed = new URL(url)
  const story = parsed.searchParams.get('story_fbid') ?? parsed.pathname.match(/\/(?:posts|videos|reel)\/(?:[^/]+\/)?(\d{8,})/)?.[1]
  if (!story || !/^[\w.-]+$/.test(profile)) return undefined
  return `https://www.facebook.com/permalink.php?story_fbid=${story}&id=${parsed.searchParams.get('id') ?? profile}`
}
