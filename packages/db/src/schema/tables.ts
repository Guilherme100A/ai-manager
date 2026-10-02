import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { bytea } from './bytea.js'
import {
  messageDirectionEnum,
  messageStatusEnum,
  proxyProtocolEnum,
  sessionStatusEnum,
  webhookChannelEnum,
} from './enums.js'

// E.164: "+" seguido de 1 a 15 dígitos, sem zero à esquerda.
export const E164_PATTERN = '^\\+[1-9][0-9]{1,14}$'
export const E164_REGEX = new RegExp(E164_PATTERN)

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

export const proxies = pgTable(
  'proxies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    protocol: proxyProtocolEnum('protocol').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    username: text('username'),
    // Senha do proxy só cifrada (AES-256-GCM, T02/T06).
    passwordCiphertext: bytea('password_ciphertext'),
    passwordIv: bytea('password_iv'),
    passwordAuthTag: bytea('password_auth_tag'),
    passwordKeyVersion: integer('password_key_version'),
    available: boolean('available').notNull().default(true),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
    lastError: text('last_error'),
    errorCount: integer('error_count').notNull().default(0),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('proxies_port_check', sql`${t.port} between 1 and 65535`)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // Opcional no cadastro por QR: o worker preenche com o número da conta quando o WhatsApp conecta.
    phone: text('phone'),
    status: sessionStatusEnum('status').notNull().default('NEW'),
    // UNIQUE: um proxy só pode estar vinculado a uma sessão; NULLs não conflitam (AC-T01-02).
    proxyId: uuid('proxy_id')
      .unique('sessions_proxy_id_unique')
      .references(() => proxies.id, { onDelete: 'set null' }),
    note: text('note'),
    requiresRestart: boolean('requires_restart').notNull().default(false),
    warmupStartedAt: timestamp('warmup_started_at', { withTimezone: true }),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_status_idx').on(t.status)],
)

// Somente material cifrado (AC-T01-03): nenhuma coluna de credencial em texto puro.
export const sessionCredentials = pgTable(
  'session_credentials',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    keyType: text('key_type').notNull(),
    keyId: text('key_id').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    iv: bytea('iv').notNull(),
    authTag: bytea('auth_tag').notNull(),
    keyVersion: integer('key_version').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: 'session_credentials_pk', columns: [t.sessionId, t.keyType, t.keyId] })],
)

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    phone: text('phone').notNull().unique('contacts_phone_unique'),
    consent: boolean('consent').notNull().default(false),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    consentSource: text('consent_source'),
    optOut: boolean('opt_out').notNull().default(false),
    lastContactAt: timestamp('last_contact_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('contacts_phone_e164_check', sql`${t.phone} ~ '^\\+[1-9][0-9]{1,14}$'`)],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    direction: messageDirectionEnum('direction').notNull().default('outbound'),
    phone: text('phone').notNull(),
    content: jsonb('content').notNull(),
    status: messageStatusEnum('status').notNull().default('queued'),
    transportMessageId: text('transport_message_id'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('messages_session_status_idx').on(t.sessionId, t.status),
    index('messages_transport_message_id_idx').on(t.transportMessageId),
  ],
)

export const messageEvents = pgTable(
  'message_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    fromStatus: messageStatusEnum('from_status'),
    toStatus: messageStatusEnum('to_status').notNull(),
    detail: jsonb('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('message_events_message_id_idx').on(t.messageId, t.createdAt)],
)

export const healthEvents = pgTable(
  'health_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // Ex.: connected, disconnected, forbidden_403, error_burst, health_degraded.
    type: text('type').notNull(),
    detail: jsonb('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('health_events_session_created_idx').on(t.sessionId, t.createdAt)],
)

export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  channel: webhookChannelEnum('channel').notNull(),
  url: text('url').notNull(),
  // Segredo HMAC do webhook genérico (AC-T11-03); config específica do canal (chat_id, destinatário etc.).
  secret: text('secret'),
  config: jsonb('config').notNull().default({}),
  // Vazio = todos os eventos alertáveis.
  events: text('events').array().notNull().default(sql`'{}'::text[]`),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detail: jsonb('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_created_idx').on(t.createdAt)],
)
