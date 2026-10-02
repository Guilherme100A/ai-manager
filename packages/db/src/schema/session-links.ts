import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { messages, sessions } from './tables.js'

export interface SessionLinkRules {
  matchText: string
  replyText: string
}

export const sessionLinks = pgTable('session_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceSessionId: uuid('source_session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  targetSessionId: uuid('target_session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  rules: jsonb('rules').$type<SessionLinkRules>().notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('session_links_distinct_sessions', sql`${t.sourceSessionId} <> ${t.targetSessionId}`),
  index('session_links_source_idx').on(t.sourceSessionId, t.enabled),
])

// Durable claim before enqueue: an uncertain delivery is never automatically replayed.
export const sessionRouteRuns = pgTable('session_route_runs', {
  linkId: uuid('link_id').notNull().references(() => sessionLinks.id, { onDelete: 'cascade' }),
  inboundId: text('inbound_id').notNull(),
  status: text('status').notNull().default('claimed'),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.linkId, t.inboundId] })])
