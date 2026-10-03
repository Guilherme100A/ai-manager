import { sql } from 'drizzle-orm'
import { boolean, check, pgTable, smallint, timestamp } from 'drizzle-orm/pg-core'

// Limite de chips por IP do proxy (linha única, id = 1). Ligado, no máximo `max_sessions_per_ip` sessões podem usar
// o mesmo IP/host e porta; desligado, não há limite. Sem linha no banco vale o padrão (desligado, 3).
export const proxySettings = pgTable(
  'proxy_settings',
  {
    id: smallint('id').primaryKey().default(1),
    ipLimitEnabled: boolean('ip_limit_enabled').notNull().default(false),
    maxSessionsPerIp: smallint('max_sessions_per_ip').notNull().default(3),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('proxy_settings_singleton_check', sql`${t.id} = 1`),
    check('proxy_settings_max_check', sql`${t.maxSessionsPerIp} >= 1 and ${t.maxSessionsPerIp} <= 50`),
  ],
)
