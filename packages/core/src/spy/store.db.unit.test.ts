// Fila do Espião com Postgres local (banco descartável): links → anúncios → ofertas por número.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb, createTempDatabase, spyAds, spyOffers, type Database, type TempDatabase } from '@wsm/db'
import { SpyFinder } from './finder'
import { SpyHttp, type FetchFn } from './http'
import { SpyRunner } from './runner'
import { SpyStore } from './store'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_spy' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

beforeEach(async () => {
  await db.delete(spyAds)
  await db.delete(spyOffers)
})

const ad = (id: string, page: string, profile: string, link: string) =>
  `{"ad_archive_id":"${id}","page_id":"${page}","snapshot":{"page_profile_uri":"https://www.facebook.com/${profile}/","page_name":"Página ${page}","cta_type":"WHATSAPP_MESSAGE","link_url":"${link}"}}`

function runnerWith(routes: Array<[RegExp, string]>) {
  const fetch: FetchFn = async (url) => {
    const hit = routes.find(([re]) => re.test(url))
    return new Response(hit ? hit[1] : '', { status: hit ? 200 : 404 })
  }
  const store = new SpyStore(db)
  const finder = new SpyFinder(new SpyHttp({ fetch, minIntervalMs: 0, sleep: async () => undefined, serperKey: 'k' }))
  return { store, runner: new SpyRunner({ store, finder }) }
}

async function drain(runner: SpyRunner) {
  let n = 0
  while (await runner.tick()) n++
  return n
}

describe('SpyStore + SpyRunner', () => {
  it('enfileira links válidos, pula inválidos e anúncio repetido', async () => {
    const store = new SpyStore(db)
    const first = await store.enqueue(['https://www.facebook.com/ads/library/?id=111', 'https://exemplo.com', 'wa.me/5511999998888'], 'admin')
    expect(first.created).toHaveLength(2)
    expect(first.skipped).toEqual([{ link: 'https://exemplo.com', reason: 'só links do Facebook ou do WhatsApp' }])
    const again = await store.enqueue(['facebook.com/ads/library/?id=111'], 'admin')
    expect(again).toMatchObject({ created: [], skipped: [{ reason: 'anúncio já está na lista' }] })
  })

  it('busca da Biblioteca vira anúncios; cada número vira uma oferta, com anúncios agrupados', async () => {
    const { store, runner } = runnerWith([
      [/q=receita/, [ad('111', '10', '6150001', 'https://api.whatsapp.com/send?phone=5511999998888'), ad('222', '10', '6150001', 'https://wa.me/5511999998888'), ad('333', '20', '6150002', 'https://api.whatsapp.com/send')].join(',')],
      [/serper/, JSON.stringify({ organic: [{ link: 'https://www.facebook.com/6150002/videos/777777777/' }] })],
      [/story_fbid=777777777&id=6150002/, '"https://api.whatsapp.com/send?phone=5584920022034&source=FB_Post"'],
    ])
    await store.enqueue(['https://www.facebook.com/ads/library/?q=receita&country=BR'], 'admin')
    expect(await drain(runner)).toBe(4) // a busca + 3 anúncios

    const rows = await store.listAds()
    expect(rows.find((r) => r.parentId === null)).toMatchObject({ status: 'expandido' })
    const byAd = Object.fromEntries(rows.filter((r) => r.adArchiveId).map((r) => [r.adArchiveId, r]))
    expect(byAd['111']).toMatchObject({ status: 'achado', phone: '5511999998888', foundVia: 'link', pageId: '10' })
    expect(byAd['333']).toMatchObject({ status: 'achado', phone: '5584920022034', foundVia: 'post' })
    expect(byAd['333']!.data.candidates).toEqual(['https://www.facebook.com/permalink.php?story_fbid=777777777&id=6150002'])

    const offers = await store.listOffers()
    expect(offers.map((o) => [o.phone, o.ads]).sort()).toEqual([['5511999998888', 2], ['5584920022034', 1]])
  })

  it('sem número: sem_numero com motivo; tentar de novo volta para a fila; falha de rede vira erro', async () => {
    const { store, runner } = runnerWith([
      [/ads\/library\/\?id=444/, ad('444', '40', '6150004', 'https://api.whatsapp.com/send')],
      [/serper/, JSON.stringify({ organic: [] })],
    ])
    const { created } = await store.enqueue(['https://www.facebook.com/ads/library/?id=444', 'https://www.facebook.com/ads/library/?id=555'], 'admin')
    await drain(runner)
    const [a, b] = await Promise.all(created.map(async (c) => (await store.listAds()).find((r) => r.id === c.id)!))
    expect(a).toMatchObject({ status: 'sem_numero', pageId: '40', pageName: 'Página 40' })
    expect(a!.error).toMatch(/página Sobre/)
    expect(b).toMatchObject({ status: 'erro' })
    expect(b!.error).toMatch(/não apareceu/)

    expect(await store.retry(a!.id)).toMatchObject({ status: 'na_fila' })
    expect(await store.retry(a!.id)).toBeUndefined() // já está na fila
    expect(await store.remove(b!.id)).toBe(true)
  })

  it('linha presa em "lendo" volta para a fila', async () => {
    const store = new SpyStore(db)
    await store.enqueue(['wa.me/5511999998888'], 'admin')
    const claimed = await store.claimNext()
    expect(claimed).toMatchObject({ status: 'lendo', attempts: 1 })
    expect(await store.claimNext()).toBeUndefined()
    expect(await store.requeueStale()).toBe(0) // recente: ainda pode estar em andamento
    // envelhece a linha pelo banco (o relógio do Postgres e o do Node podem empatar no mesmo ms)
    await db.update(spyAds).set({ updatedAt: new Date(Date.now() - 11 * 60_000) })
    expect(await store.requeueStale()).toBe(1)
  })
})
