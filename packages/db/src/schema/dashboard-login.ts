import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** Remembered dashboard logins. Only a token hash is persisted; revocation survives API restarts. */
export const dashboardLoginSessions = pgTable('dashboard_login_sessions', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  username: text('username').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [index('dashboard_login_sessions_expiry_idx').on(t.expiresAt)])
