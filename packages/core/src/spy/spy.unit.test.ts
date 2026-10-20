import { describe, expect, it } from 'vitest'
import { permalinkFor, SpyFinder } from './finder'
import { resultUrls, SpyHttp, type FetchFn } from './http'
import { aboutPagePhone, classifyInput, isWhatsappAd, normalizePhone, parseLibraryAds, postButtonPhone, profilePostLinks, textPhone } from './parse'

// Trecho no formato que a Biblioteca embute no HTML (JSON com `\/` e `\u00xx`).
const adJson = (id: string, page: string, profile: string, link: string, body = 'Receitas que vendem') =>
  `{"ad_archive_id":"${id}","collation_id":"9","page_id":"${page}","snapshot":{"page_profile_uri":"https:\\/\\/www.facebook.com\\/${profile}\\/",` +
  `"page_name":"Chef Maria Vit\\u00f3ria","body":{"text":"${body}"},"cta_type":"WHATSAPP_MESSAGE","link_url":"${link}","title":"Fale comigo",` +
  `"display_format":"VIDEO","videos":[{"video_sd_url":"https:\\/\\/video.fbcdn.net\\/v.mp4"}]},"start_date":1790146800}`
const libraryHtml = (...ads: string[]) => `<html><script>{"data":[${ads.join(',')}]}</script></html>`.split('\\/').join('/')

describe('parse', () => {
  it('normaliza números e descarta o placeholder do Facebook', () => {
    expect(normalizePhone('+55 (84) 92002-2034')).toBe('5584920022034')
    expect(normalizePhone('16505555555')).toBeUndefined()
    expect(normalizePhone('12345')).toBeUndefined()
  })

  it('classifica os links aceitos', () => {
    expect(classifyInput('https://wa.me/5584920022034?text=oi')).toEqual({ kind: 'whatsapp', phone: '5584920022034' })
    expect(classifyInput('facebook.com/ads/library/?id=2177430813049919')).toEqual({ kind: 'ad', adArchiveId: '2177430813049919', url: 'https://www.facebook.com/ads/library/?id=2177430813049919' })
    expect(classifyInput('https://www.facebook.com/ads/library/?active_status=active&q=receita&country=BR').kind).toBe('search')
    expect(classifyInput('https://m.facebook.com/61577928417447/videos/1738211550515405/').kind).toBe('post')
    expect(classifyInput('https://www.facebook.com/permalink.php?story_fbid=1&id=2').kind).toBe('post')
    expect(classifyInput('https://exemplo.com/x')).toMatchObject({ kind: 'invalid' })
    expect(classifyInput('https://www.facebook.com/ads/library/')).toMatchObject({ kind: 'invalid' })
  })

  it('lê os anúncios da Biblioteca: página, perfil, botão, destino e texto', () => {
    const ads = parseLibraryAds(libraryHtml(
      adJson('111', '622682597605911', '61577928417447', 'https://api.whatsapp.com/send'),
      adJson('222', '1', 'deliciasdamih', 'https://api.whatsapp.com/send?phone=5511999998888'),
    ))
    expect(ads).toHaveLength(2)
    expect(ads[0]).toMatchObject({ adArchiveId: '111', pageId: '622682597605911', pageName: 'Chef Maria Vitória', profileToken: '61577928417447', ctaType: 'WHATSAPP_MESSAGE', body: 'Receitas que vendem', startDate: 1790146800 })
    expect(ads[1]!.profileToken).toBe('deliciasdamih')
    expect(ads.every(isWhatsappAd)).toBe(true)
  })

  it('número do botão do post (source=FB_Post) e do texto livre', () => {
    const post = '<a href="https://api.whatsapp.com/send?phone=5511000000000">x</a> "url":"https://api.whatsapp.com/send?phone=5584920022034&source=FB_Post&token=abc"'
    expect(postButtonPhone(post)).toBe('5584920022034')
    expect(postButtonPhone('nada aqui')).toBeUndefined()
    expect(textPhone('Chama no zap +55 79 9107-3072 agora')).toBe('557991073072')
    expect(textPhone('Fale conosco https%3A%2F%2Fwa.me%2F5579991073072')).toBe('5579991073072')
  })

  it('página Sobre: só o campo WhatsApp ou o botão da seção de contato, nunca telefone solto', () => {
    const field = '{"field_section_type":"about_contact_info","profile_fields":{"nodes":[{"title":{"ranges":[],"text":"+55 79 9107-3072"},"field_type":"whatsapp"}]}}'
    expect(aboutPagePhone(`sugestão +55 13 3150-1541 ${field}`)).toBe('557991073072')
    expect(aboutPagePhone('{"field_section_type":"about_contact_info","link_url":"https://api.whatsapp.com/send?phone=5511919589408&token=eyJ"}')).toBe('5511919589408')
    expect(aboutPagePhone('Fale com +55 13 3150-1541 e https://api.whatsapp.com/send?phone=5511999998888&token=x')).toBeUndefined()
  })

  it('resultados da busca: só posts/vídeos do próprio perfil, vídeos primeiro', () => {
    const html = '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.facebook.com%2F61577928417447%2Fposts%2F122166543716930947%2F&rut=x">' +
      '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.facebook.com%2F61577928417447%2Fvideos%2F1738211550515405%2F&rut=y">' +
      '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.facebook.com%2Foutra.pessoa%2Fposts%2F1%2F&rut=z">' +
      '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.facebook.com%2F61577928417447%2F&rut=w">'
    expect(profilePostLinks(resultUrls(html), '61577928417447')).toEqual([
      'https://www.facebook.com/61577928417447/videos/1738211550515405/',
      'https://www.facebook.com/61577928417447/posts/122166543716930947/',
    ])
  })

  it('monta o permalink com o id do post/vídeo e o id do perfil', () => {
    expect(permalinkFor('https://www.facebook.com/61577928417447/videos/1738211550515405/', '61577928417447'))
      .toBe('https://www.facebook.com/permalink.php?story_fbid=1738211550515405&id=61577928417447')
    expect(permalinkFor('https://www.facebook.com/61582021154075/posts/%2Dver%2Dmeu%2Dfilho/122118423477067371/', '61582021154075'))
      .toBe('https://www.facebook.com/permalink.php?story_fbid=122118423477067371&id=61582021154075')
    expect(permalinkFor('https://www.facebook.com/61582021154075/', '61582021154075')).toBeUndefined()
  })
})

/** Fetch falso por URL; registra as chamadas. */
function fakeFetch(routes: Array<[RegExp, (init?: RequestInit) => Response]>) {
  const calls: string[] = []
  const fn: FetchFn = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const route = routes.find(([re]) => re.test(url))
    if (!route) return new Response('not found', { status: 404 })
    return route[1](init)
  }
  return { fn, calls }
}
const html = (body: string, status = 200, headers: Record<string, string> = {}) => () => new Response(body, { status, headers })
const fastHttp = (fetch: FetchFn, serperKey?: string) => new SpyHttp({ fetch, minIntervalMs: 0, sleep: async () => undefined, serperKey })

describe('SpyHttp', () => {
  it('resolve o desafio __rd_verify guardando o cookie e repete a requisição', async () => {
    let verified = false
    const { fn, calls } = fakeFetch([
      [/__rd_verify_/, () => { verified = true; return new Response('', { status: 200, headers: { 'set-cookie': 'rd_challenge=ok; Path=/' } }) }],
      [/ads\/library/, () => verified ? new Response('{"ad_archive_id":"1"}') : new Response("<script>fetch('/__rd_verify_ABC?challenge=3',{method:'POST'})</script>", { status: 403 })],
    ])
    const page = await fastHttp(fn).facebook('https://www.facebook.com/ads/library/?id=1')
    expect(page.status).toBe(200)
    expect(page.text).toContain('ad_archive_id')
    expect(calls).toEqual(['GET https://www.facebook.com/ads/library/?id=1', 'POST https://www.facebook.com/__rd_verify_ABC?challenge=3', 'GET https://www.facebook.com/ads/library/?id=1'])
  })

  it('facebookFetch (proxy) só para a Facebook; o buscador sai direto', async () => {
    const direct: string[] = []
    const proxied: string[] = []
    const http = new SpyHttp({
      fetch: async (url) => { direct.push(url); return new Response('') },
      facebookFetch: async (url) => { proxied.push(url); return new Response('') },
      minIntervalMs: 0, sleep: async () => undefined,
    })
    await http.facebook('https://www.facebook.com/permalink.php?story_fbid=1&id=2')
    await http.search('site:facebook.com 2')
    expect(proxied).toEqual(['https://www.facebook.com/permalink.php?story_fbid=1&id=2'])
    expect(direct).toEqual(['https://html.duckduckgo.com/html/?q=site%3Afacebook.com%202'])

    const searched: string[] = []
    const viaProxy = new SpyHttp({ fetch: async (url) => { direct.push(url); return new Response('') }, searchFetch: async (url) => { searched.push(url); return new Response('') }, minIntervalMs: 0, sleep: async () => undefined })
    await viaProxy.search('q')
    expect(searched).toEqual(['https://html.duckduckgo.com/html/?q=q'])
  })

  it('conexão que cai no meio é repetida uma vez; a segunda queda propaga', async () => {
    let n = 0
    const flaky: FetchFn = async () => { n++; if (n === 1) throw new TypeError('terminated'); return new Response('ok') }
    expect((await fastHttp(flaky).facebook('https://www.facebook.com/x')).text).toBe('ok')
    expect(n).toBe(2)
    const down: FetchFn = async () => { throw new TypeError('fetch failed') }
    await expect(fastHttp(down).facebook('https://www.facebook.com/x')).rejects.toThrow('fetch failed')
  })

  it('busca: Serper com chave; DuckDuckGo sem chave, avisando o bloqueio anti-robô', async () => {
    const { fn } = fakeFetch([
      [/serper/, (init) => { expect((init!.headers as Record<string, string>)['X-API-KEY']).toBe('k'); return Response.json({ organic: [{ link: 'https://www.facebook.com/p/videos/1/' }] }) }],
      [/duckduckgo/, html('<div class="anomaly-modal"></div>', 202)],
    ])
    expect(await fastHttp(fn, 'k').search('q')).toEqual({ provider: 'serper', blocked: false, urls: ['https://www.facebook.com/p/videos/1/'] })
    expect(await fastHttp(fn).search('q')).toMatchObject({ provider: 'duckduckgo', blocked: true, urls: [] })
  })
})

describe('SpyFinder', () => {
  const ad = parseLibraryAds(libraryHtml(adJson('111', '622682597605911', '61577928417447', 'https://api.whatsapp.com/send')))[0]!

  it('número no destino do anúncio: não abre mais nada', async () => {
    const { fn, calls } = fakeFetch([])
    const r = await new SpyFinder(fastHttp(fn)).findForAd({ ...ad, linkUrl: 'https://api.whatsapp.com/send?phone=5511999998888' })
    expect(r).toMatchObject({ phone: '5511999998888', foundVia: 'link' })
    expect(calls).toEqual([])
  })

  it('cascata: busca do perfil → permalink do vídeo → botão do WhatsApp', async () => {
    const { fn, calls } = fakeFetch([
      [/serper/, () => Response.json({ organic: [{ link: 'https://www.facebook.com/61577928417447/videos/1738211550515405/' }, { link: 'https://www.facebook.com/outra/posts/1/' }] })],
      [/permalink\.php\?story_fbid=1738211550515405&id=61577928417447/, html('"https:\\/\\/api.whatsapp.com\\/send?phone=5584920022034&source=FB_Post&token=x"')],
    ])
    const r = await new SpyFinder(fastHttp(fn, 'k')).findForAd(ad)
    expect(r).toMatchObject({ phone: '5584920022034', foundVia: 'post', evidenceUrl: 'https://www.facebook.com/permalink.php?story_fbid=1738211550515405&id=61577928417447' })
    expect(calls.filter((c) => c.includes('facebook.com'))).toEqual(['GET https://www.facebook.com/permalink.php?story_fbid=1738211550515405&id=61577928417447'])
  })

  it('sem posts com botão: tenta a página Sobre; sem nada, explica o motivo', async () => {
    const about = fakeFetch([
      [/duckduckgo/, html('<html>sem resultados</html>')],
      [/sk=about_contact/, html('{"field_section_type":"about_contact_info","profile_fields":{"nodes":[{"title":{"text":"+55 84 92002-2034"},"field_type":"whatsapp"}]}}')],
    ])
    expect(await new SpyFinder(fastHttp(about.fn)).findForAd(ad)).toMatchObject({ phone: '5584920022034', foundVia: 'pagina' })

    const refused = fakeFetch([[/duckduckgo/, () => { throw new TypeError('fetch failed') }], [/sk=about_contact/, html('{"field_section_type":"about_contact_info","x":[{"title":{"text":"+55 84 92002-2034"},"field_type":"whatsapp"}]}')]])
    expect(await new SpyFinder(fastHttp(refused.fn)).findForAd(ad)).toMatchObject({ phone: '5584920022034', foundVia: 'pagina' })

    const blocked = fakeFetch([[/duckduckgo/, html('anomaly-modal', 202)], [/facebook/, html('<html></html>')]])
    const r = await new SpyFinder(fastHttp(blocked.fn)).findForAd(ad)
    expect(r.phone).toBeUndefined()
    expect(r.reason).toMatch(/bloqueou/)
  })

  it('post que redireciona para o login (IP de servidor): motivo pede proxy residencial', async () => {
    const { fn } = fakeFetch([
      [/permalink\.php/, html('', 302, { location: 'https://www.facebook.com/login/?next=x' })],
      [/\/login\//, html('<form id="login_form"></form>')],
    ])
    const r = await new SpyFinder(fastHttp(fn)).findForPost('https://www.facebook.com/61577928417447/videos/1738211550515405/')
    expect(r.phone).toBeUndefined()
    expect(r.reason).toMatch(/pediu login.*SPY_PROXY_URL/)
  })

  it('loadAd acha o anúncio pelo id na página da Biblioteca', async () => {
    const { fn } = fakeFetch([[/ads\/library\/\?id=111/, html(libraryHtml(adJson('999', '1', 'x', 'u'), adJson('111', '622682597605911', '61577928417447', 'https://api.whatsapp.com/send')))]])
    expect((await new SpyFinder(fastHttp(fn)).loadAd('111')).pageId).toBe('622682597605911')
    await expect(new SpyFinder(fastHttp(fn)).loadAd('555')).rejects.toThrow(/não apareceu/)
  })
})
