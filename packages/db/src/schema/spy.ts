import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { bytea } from './bytea.js'
import { messages, sessions } from './tables.js'

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

export type SpyProbeStatus = 'ativa' | 'concluida' | 'parada' | 'erro'
/** Caminho que a sonda segue: principal (até o checkout), objeção ("tá caro"), sumiu (some depois do preço). */
export const SPY_BRANCHES = ['principal', 'objecao', 'sumiu'] as const
export type SpyBranch = (typeof SPY_BRANCHES)[number]

/** O que a IA da sonda anotou sobre o funil (preço, checkout, etapas, opções vistas). */
export interface SpyProbeSummary {
  etapa?: string
  preco?: string
  checkout?: string[]
  opcoes?: string[]
  notas?: string
  humano?: boolean
  /** Todos os links que a oferta mandou. */
  links?: string[]
}

/**
 * Sonda: um chip conversa com a oferta (número achado) como um lead, até o preço/checkout. Depois de encerrar,
 * continua só ouvindo até `listenUntil` para gravar o remarketing. Uma sonda ativa por número.
 */
export const spyProbes = pgTable('spy_probes', {
  id: uuid('id').primaryKey().defaultRandom(),
  offerId: uuid('offer_id').notNull().references(() => spyOffers.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  phone: text('phone').notNull(),
  branch: text('branch').notNull().default('principal'),
  status: text('status').$type<SpyProbeStatus>().notNull().default('ativa'),
  turns: integer('turns').notNull().default(0),
  maxTurns: integer('max_turns').notNull().default(12),
  /** Resposta pendente: a sonda responde a partir deste horário (atraso humano, junta mensagens seguidas). */
  replyDueAt: timestamp('reply_due_at', { withTimezone: true }),
  /** Última mensagem da oferta já vista (inclui áudio/imagem, que não têm texto). */
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  /** Última mensagem enviada pela sonda (oferta que parou de responder encerra a sonda). */
  lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
  listenUntil: timestamp('listen_until', { withTimezone: true }),
  summary: jsonb('summary').$type<SpyProbeSummary>().notNull().default({}),
  endedReason: text('ended_reason'),
  createdBy: text('created_by').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Várias sondas na mesma oferta, uma por ramificação e cada uma num chip (a conversa é por chip + número).
  uniqueIndex('spy_probes_active_branch_idx').on(t.phone, t.branch).where(sql`${t.status} = 'ativa'`),
  uniqueIndex('spy_probes_active_session_idx').on(t.phone, t.sessionId).where(sql`${t.status} = 'ativa'`),
  index('spy_probes_session_idx').on(t.sessionId, t.status),
])

export type SpyMediaKind = 'image' | 'document' | 'audio' | 'video'

/**
 * Arquivos de mídia que a oferta mandou numa sonda (imagem, PDF, áudio e vídeo), guardados para o pacote (ZIP) do
 * fluxo. Os bytes ficam no banco porque worker (captura) e API (download do ZIP) não compartilham disco; o cache do
 * transporte já expirou quando o usuário baixa. Áudio/vídeo também viram transcrição no texto da mensagem.
 */
export const spyMedia = pgTable('spy_media', {
  id: uuid('id').primaryKey().defaultRandom(),
  offerId: uuid('offer_id').notNull().references(() => spyOffers.id, { onDelete: 'cascade' }),
  probeId: uuid('probe_id').references(() => spyProbes.id, { onDelete: 'set null' }),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  branch: text('branch'),
  kind: text('kind').$type<SpyMediaKind>().notNull(),
  mime: text('mime').notNull(),
  fileName: text('file_name'),
  bytes: bytea('bytes').notNull(),
  size: integer('size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('spy_media_offer_idx').on(t.offerId, t.createdAt),
  // Uma mídia por mensagem (não duplica se a captura rodar de novo).
  uniqueIndex('spy_media_message_idx').on(t.messageId).where(sql`${t.messageId} is not null`),
])
