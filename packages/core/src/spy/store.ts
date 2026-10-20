import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { spyAds, spyOffers, type Database, type SpyAdData, type SpyFoundVia } from '@wsm/db'
import { classifyInput, type LibraryAd } from './parse'

export type SpyAdRow = typeof spyAds.$inferSelect
export type SpyOfferRow = typeof spyOffers.$inferSelect

export interface SpyOfferView extends SpyOfferRow {
  ads: number
}

export function adData(ad: LibraryAd): SpyAdData {
  return {
    ctaType: ad.ctaType, linkUrl: ad.linkUrl, body: ad.body, title: ad.title, displayFormat: ad.displayFormat,
    profileUri: ad.profileUri, startDate: ad.startDate, images: ad.images, videos: ad.videos,
  }
}

export class SpyStore {
  constructor(private readonly db: Database) {}

  listAds(limit = 300) { return this.db.select().from(spyAds).orderBy(desc(spyAds.createdAt)).limit(limit) }

  async listOffers(): Promise<SpyOfferView[]> {
    const rows = await this.db.select({ offer: spyOffers, ads: sql<number>`count(${spyAds.id})::int` })
      .from(spyOffers).leftJoin(spyAds, eq(spyAds.offerId, spyOffers.id))
      .groupBy(spyOffers.id).orderBy(desc(spyOffers.createdAt))
    return rows.map((r) => ({ ...r.offer, ads: r.ads }))
  }

  /** Cada link vira uma linha na fila; anúncio já cadastrado (mesmo id da Biblioteca) é pulado. */
  async enqueue(links: string[], createdBy: string) {
    const created: SpyAdRow[] = []
    const skipped: Array<{ link: string; reason: string }> = []
    for (const link of links) {
      const input = classifyInput(link)
      if (input.kind === 'invalid') { skipped.push({ link, reason: input.reason }); continue }
      const [row] = await this.db.insert(spyAds).values({
        inputUrl: link.trim(), createdBy, adArchiveId: input.kind === 'ad' ? input.adArchiveId : null,
      }).onConflictDoNothing().returning()
      if (row) created.push(row)
      else skipped.push({ link, reason: 'anúncio já está na lista' })
    }
    return { created, skipped }
  }

  /** Próxima linha da fila, marcada como 'lendo' (uma por vez, sem disputa entre processos). */
  async claimNext(): Promise<SpyAdRow | undefined> {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      update spy_ads set status = 'lendo', attempts = attempts + 1, updated_at = now()
      where id = (select id from spy_ads where status = 'na_fila' order by created_at limit 1 for update skip locked)
      returning id`)
    const id = rows[0]?.id
    if (!id) return undefined
    return (await this.db.select().from(spyAds).where(eq(spyAds.id, id)))[0]
  }

  /** Linhas presas em 'lendo' (processo reiniciado no meio) voltam para a fila. */
  async requeueStale(olderThanMs = 10 * 60_000) {
    const rows = await this.db.update(spyAds).set({ status: 'na_fila', updatedAt: new Date() })
      .where(and(eq(spyAds.status, 'lendo'), lt(spyAds.updatedAt, new Date(Date.now() - olderThanMs)))).returning({ id: spyAds.id })
    return rows.length
  }

  async saveAd(id: string, ad: LibraryAd) {
    await this.db.update(spyAds).set({ adArchiveId: ad.adArchiveId, pageId: ad.pageId ?? null, pageName: ad.pageName ?? null, data: adData(ad), updatedAt: new Date() }).where(eq(spyAds.id, id))
  }

  /** Busca da Biblioteca: a linha vira 'expandido' e cada anúncio de WhatsApp entra na fila já lido. */
  async expand(parent: SpyAdRow, ads: LibraryAd[]) {
    let added = 0
    for (const ad of ads) {
      const [row] = await this.db.insert(spyAds).values({
        inputUrl: `https://www.facebook.com/ads/library/?id=${ad.adArchiveId}`, parentId: parent.id, createdBy: parent.createdBy,
        adArchiveId: ad.adArchiveId, pageId: ad.pageId ?? null, pageName: ad.pageName ?? null, data: adData(ad),
      }).onConflictDoNothing().returning({ id: spyAds.id })
      if (row) added++
    }
    await this.db.update(spyAds).set({ status: 'expandido', error: `${added} anúncio(s) de WhatsApp adicionados (${ads.length - added} já estavam na lista)`, updatedAt: new Date() }).where(eq(spyAds.id, parent.id))
    return added
  }

  /** Número achado: liga o anúncio à oferta daquele número (cria a oferta na primeira vez). */
  async found(id: string, result: { phone: string; foundVia: SpyFoundVia; evidenceUrl?: string; candidates?: string[] }) {
    const [ad] = await this.db.select().from(spyAds).where(eq(spyAds.id, id))
    if (!ad) return undefined
    const [offer] = await this.db.insert(spyOffers).values({ phone: result.phone, pageId: ad.pageId, pageName: ad.pageName })
      .onConflictDoUpdate({ target: spyOffers.phone, set: { updatedAt: new Date() } }).returning()
    const [row] = await this.db.update(spyAds).set({
      status: 'achado', phone: result.phone, foundVia: result.foundVia, evidenceUrl: result.evidenceUrl ?? null, error: null, offerId: offer!.id,
      data: result.candidates ? { ...ad.data, candidates: result.candidates } : ad.data, updatedAt: new Date(),
    }).where(eq(spyAds.id, id)).returning()
    return row
  }

  async notFound(id: string, reason: string, candidates: string[]) {
    const [ad] = await this.db.select().from(spyAds).where(eq(spyAds.id, id))
    if (!ad) return
    await this.db.update(spyAds).set({ status: 'sem_numero', error: reason, data: { ...ad.data, candidates }, updatedAt: new Date() }).where(eq(spyAds.id, id))
  }

  async failed(id: string, error: string) {
    await this.db.update(spyAds).set({ status: 'erro', error: error.slice(0, 500), updatedAt: new Date() }).where(eq(spyAds.id, id))
  }

  async retry(id: string) {
    const [row] = await this.db.update(spyAds).set({ status: 'na_fila', error: null, updatedAt: new Date() })
      .where(and(eq(spyAds.id, id), inArray(spyAds.status, ['sem_numero', 'erro']))).returning()
    return row
  }

  async remove(id: string) {
    const rows = await this.db.delete(spyAds).where(eq(spyAds.id, id)).returning({ id: spyAds.id })
    return rows.length > 0
  }
}
