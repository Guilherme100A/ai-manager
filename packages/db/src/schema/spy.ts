import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

// Espião de funil: cada link colado vira uma linha em spy_ads; o número achado agrupa os anúncios em spy_offers.
export type SpyAdStatus = 'na_fila' | 'lendo' | 'achado' | 'sem_numero' | 'erro' | 'expandido'
export type SpyFoundVia = 'link' | 'texto' | 'post' | 'pagina' | 'manual'

export interface SpyAdData {
  ctaType?: string
  linkUrl?: string
  body?: string
  title?: string
  displayFormat?: string
  profileUri?: string
  startDate?: number
  images?: string[]
  videos?: string[]
  /** Posts/vídeos da página que a busca encontrou e abriu (evidência do número). */
  candidates?: string[]
}

export const spyOffers = pgTable('spy_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull(),
  pageId: text('page_id'),
  pageName: text('page_name'),
  status: text('status').notNull().default('nova'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('spy_offers_phone_idx').on(t.phone)])

export const spyAds = pgTable('spy_ads', {
  id: uuid('id').primaryKey().defaultRandom(),
  inputUrl: text('input_url').notNull(),
  /** Linha de busca da Biblioteca que gerou esta (status 'expandido' no pai). */
  parentId: uuid('parent_id'),
  adArchiveId: text('ad_archive_id'),
  pageId: text('page_id'),
  pageName: text('page_name'),
  status: text('status').$type<SpyAdStatus>().notNull().default('na_fila'),
  phone: text('phone'),
  foundVia: text('found_via').$type<SpyFoundVia>(),
  evidenceUrl: text('evidence_url'),
  error: text('error'),
  data: jsonb('data').$type<SpyAdData>().notNull().default({}),
  offerId: uuid('offer_id').references(() => spyOffers.id, { onDelete: 'set null' }),
  attempts: integer('attempts').notNull().default(0),
  /** Buscador bloqueou: a linha volta para a fila, mas só sai dela a partir deste horário. */
  retryAt: timestamp('retry_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('spy_ads_archive_idx').on(t.adArchiveId).where(sql`${t.adArchiveId} is not null`),
  index('spy_ads_status_idx').on(t.status, t.createdAt),
])
