// Cliente HTTP do Espião: Facebook sem login (desafio __rd_verify + cookies) e busca no DuckDuckGo.
// Só GET de páginas públicas, devagar (intervalo mínimo entre requisições ao mesmo host).

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface SpyHttpOptions {
  fetch?: FetchFn
  /** Intervalo mínimo entre duas requisições ao mesmo host (ms). */
  minIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  userAgent?: string
  /** Chave da API do Serper (SPY_SERPER_KEY); sem ela a busca usa o DuckDuckGo. */
  serperKey?: string
}

export interface SpyPage {
  status: number
  url: string
  /** HTML com `\/` desfeito, pronto para as regex de extração. */
  text: string
}

export interface SearchResult {
  provider: 'serper' | 'duckduckgo'
  /** O buscador respondeu com a tela anti-robô em vez de resultados. */
  blocked: boolean
  urls: string[]
}

/** Links (já decodificados) de uma página HTML de resultados do DuckDuckGo. */
export function resultUrls(html: string): string[] {
  const urls = new Set<string>()
  for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
    try { urls.add(decodeURIComponent(m[1]!)) } catch { /* link quebrado no resultado */ }
  }
  for (const m of html.matchAll(/https:\/\/(?:www\.|m\.|web\.)?facebook\.com\/[^"'\s<>]+/g)) urls.add(m[0].replace(/&amp;/g, '&'))
  return [...urls]
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const MAX_REDIRECTS = 5

export class SpyHttp {
  private readonly fetchFn: FetchFn
  private readonly minIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly userAgent: string
  private readonly serperKey: string | undefined
  private readonly jar = new Map<string, string>()
  private readonly lastAt = new Map<string, number>()

  constructor(options: SpyHttpOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init))
    this.minIntervalMs = options.minIntervalMs ?? 2_000
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = options.now ?? Date.now
    this.userAgent = options.userAgent ?? DEFAULT_UA
    this.serperKey = options.serperKey?.trim() || undefined
  }

  /** Abre uma página do Facebook resolvendo o desafio anti-robô quando ele aparece. */
  async facebook(url: string): Promise<SpyPage> {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res = await this.raw(current)
      const challenge = res.text.match(/\/__rd_verify_[^'"]+/)?.[0]
      if (challenge) {
        const origin = new URL(current).origin
        await this.raw(origin + challenge, { method: 'POST', headers: { origin, referer: current, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })
        res = await this.raw(current)
      }
      if (res.location && res.status >= 300 && res.status < 400) {
        current = new URL(res.location, current).href
        continue
      }
      return { status: res.status, url: current, text: res.text.split('\\/').join('/') }
    }
    throw new Error('redirecionamentos demais')
  }

  /**
   * Links de resultado de uma busca na web. Com `serperKey`, usa a API do Serper (resultados do Google);
   * sem chave, a página HTML do DuckDuckGo, que bloqueia IPs de datacenter com frequência (`blocked`).
   */
  async search(query: string): Promise<SearchResult> {
    if (this.serperKey) {
      const res = await this.fetchFn('https://google.serper.dev/search', {
        method: 'POST', headers: { 'X-API-KEY': this.serperKey, 'content-type': 'application/json' },
        body: JSON.stringify({ q: query, num: 20 }), signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`busca (Serper) respondeu HTTP ${res.status}`)
      const body = await res.json() as { organic?: Array<{ link?: string }> }
      return { provider: 'serper', blocked: false, urls: (body.organic ?? []).map((o) => o.link).filter((l): l is string => typeof l === 'string') }
    }
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const res = await this.raw(url, { cookies: false })
    return { provider: 'duckduckgo', blocked: res.status === 202 || /anomaly-modal|challenge-form/.test(res.text), urls: resultUrls(res.text) }
  }

  /** Uma nova tentativa quando a conexão cai no meio (`fetch failed`, `terminated`); timeout e HTTP de erro não repetem. */
  private async raw(url: string, opts: { method?: string; headers?: Record<string, string>; cookies?: boolean } = {}) {
    try {
      return await this.once(url, opts)
    } catch (err) {
      if (!(err instanceof TypeError)) throw err
      await this.sleep(this.minIntervalMs + 1_000)
      return this.once(url, opts)
    }
  }

  private async once(url: string, opts: { method?: string; headers?: Record<string, string>; cookies?: boolean }) {
    const host = new URL(url).host
    const wait = (this.lastAt.get(host) ?? 0) + this.minIntervalMs - this.now()
    if (wait > 0) await this.sleep(wait)
    this.lastAt.set(host, this.now())
    const useJar = opts.cookies !== false
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      'accept-language': 'pt-BR,pt;q=0.9,es;q=0.8,en;q=0.7',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'same-origin',
      ...opts.headers,
    }
    if (useJar && this.jar.size > 0) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await this.fetchFn(url, { method: opts.method ?? 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    if (useJar) {
      for (const cookie of res.headers.getSetCookie?.() ?? []) {
        const [pair] = cookie.split(';')
        const i = pair!.indexOf('=')
        if (i > 0) this.jar.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim())
      }
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text() }
  }
}
