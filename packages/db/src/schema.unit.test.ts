import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  E164_REGEX,
  MESSAGE_STATUSES,
  MIGRATIONS_FOLDER,
  SESSION_STATUSES,
  contacts,
  createDb,
  createTempDatabase,
  messages,
  proxies,
  runMigrations,
  sessionCredentials,
  sessions,
  withDatabase,
  type Database,
  type TempDatabase,
} from './index.js'

const TABLES = [
  'sessions',
  'session_credentials',
  'proxies',
  'contacts',
  'messages',
  'message_events',
  'health_events',
  'webhooks',
  'audit_logs',
  // T09 — migration 0001_session_limits
  'session_limits',
  // T13 — migration 0002_suggestions
  'suggestions',
  // T19 — migration 0003_ai_settings
  'ai_settings',
  // migration 0004_session_router
  'session_links',
  'session_route_runs',
  // migration 0006_proxy_settings
  'proxy_settings',
]

/** Quantidade de migrations declaradas no journal do drizzle (cresce a cada migration nova). */
const MIGRATION_COUNT = (
  JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }
).entries.length

// Erro de constraint do Postgres (drizzle embrulha o erro do pg em `cause`).
async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string; constraint?: string } }
    return e.cause ?? e
  }
  throw new Error('esperava falha no banco')
}

describe('schema (estático)', () => {
  it('session_credentials só tem colunas cifradas e a chave', () => {
    const cols = Object.values(getTableColumns(sessionCredentials)).map((c) => c.name).sort()
    expect(cols).toEqual(['auth_tag', 'ciphertext', 'iv', 'key_id', 'key_type', 'key_version', 'session_id', 'updated_at'])
  })

  it('enums espelham SPEC 3.2 e 3.3', () => {
    expect(SESSION_STATUSES).toEqual(['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED'])
    expect(MESSAGE_STATUSES).toEqual(['queued', 'processing', 'sent', 'delivered', 'read', 'failed', 'retrying', 'cancelled'])
  })

  it('E164_REGEX', () => {
    expect(E164_REGEX.test('+5511999999999')).toBe(true)
    expect(E164_REGEX.test('5511999999999')).toBe(false)
    expect(E164_REGEX.test('+0123')).toBe(false)
    expect(E164_REGEX.test('+1234567890123456')).toBe(false)
  })

  it('withDatabase troca só o nome do banco', () => {
    expect(withDatabase('postgres://u:p@h:5432/wsm?sslmode=disable', 'x')).toBe('postgres://u:p@h:5432/x?sslmode=disable')
  })

  it('nomes de tabela', () => {
    expect([sessions, contacts, messages, proxies].map(getTableName)).toEqual(['sessions', 'contacts', 'messages', 'proxies'])
  })
})

describe('schema (Postgres)', () => {
  let tmp: TempDatabase
  let db: Database

  beforeAll(async () => {
    tmp = await createTempDatabase()
    db = createDb(tmp.url, { max: 2 })
    await runMigrations(db)
  })

  afterAll(async () => {
    await db?.$client.end()
    await tmp?.drop()
  })

  it('cria todas as tabelas do schema', async () => {
    const { rows } = await db.$client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    )
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort())
  })

  it('migrations são idempotentes', async () => {
    await runMigrations(db)
    await runMigrations(db)
    const { rows } = await db.$client.query('select count(*)::int as n from drizzle.__drizzle_migrations')
    expect(MIGRATION_COUNT).toBeGreaterThanOrEqual(1)
    expect(rows[0].n).toBe(MIGRATION_COUNT)
  })

  it('proxy_id é único entre sessões, NULL não conflita', async () => {
    const [proxy] = await db.insert(proxies).values({ protocol: 'http', host: '127.0.0.1', port: 8080 }).returning()
    await db.insert(sessions).values({ name: 'a', phone: '+5511900000001', proxyId: proxy!.id })
    const e = await pgError(db.insert(sessions).values({ name: 'b', phone: '+5511900000002', proxyId: proxy!.id }))
    expect(e.code).toBe('23505')
    await db.insert(sessions).values([
      { name: 'c', phone: '+5511900000003' },
      { name: 'd', phone: '+5511900000004' },
    ])
  })

  it('contacts: phone único e E.164, opt_out default false', async () => {
    const [c] = await db.insert(contacts).values({ phone: '+5511911111111' }).returning()
    expect(c!.optOut).toBe(false)
    expect(c!.consent).toBe(false)
    expect((await pgError(db.insert(contacts).values({ phone: '+5511911111111' }))).code).toBe('23505')
    expect((await pgError(db.insert(contacts).values({ phone: '11911111111' }))).code).toBe('23514')
  })

  it('status inválido é rejeitado pelo banco', async () => {
    const e1 = await pgError(db.$client.query("insert into sessions (name, phone, status) values ('x', '+1', 'CONNECTED')"))
    expect(e1.code).toBe('22P02')
    const [s] = await db.insert(sessions).values({ name: 'm', phone: '+5511922222222' }).returning()
    const e2 = await pgError(
      db.$client.query("insert into messages (session_id, phone, content, status) values ($1, '+1', '{}', 'bogus')", [s!.id]),
    )
    expect(e2.code).toBe('22P02')
    const [m] = await db.insert(messages).values({ sessionId: s!.id, phone: '+5511933333333', content: { text: 'oi' } }).returning()
    expect(m!.status).toBe('queued')
  })

  it('session_credentials guarda bytea e usa chave composta', async () => {
    const [s] = await db.insert(sessions).values({ name: 'cred', phone: '+5511944444444' }).returning()
    const row = {
      sessionId: s!.id,
      keyType: 'creds',
      keyId: 'main',
      ciphertext: Buffer.from([1, 2, 3]),
      iv: Buffer.alloc(12),
      authTag: Buffer.alloc(16),
      keyVersion: 1,
    }
    await db.insert(sessionCredentials).values(row)
    const [back] = await db.select().from(sessionCredentials)
    expect(Buffer.isBuffer(back!.ciphertext)).toBe(true)
    expect([...back!.ciphertext]).toEqual([1, 2, 3])
    expect((await pgError(db.insert(sessionCredentials).values(row))).code).toBe('23505')
  })

  it('FK de session_credentials rejeita sessão inexistente', async () => {
    const e = await pgError(
      db.insert(sessionCredentials).values({
        sessionId: randomUUID(),
        keyType: 'creds',
        keyId: 'x',
        ciphertext: Buffer.alloc(1),
        iv: Buffer.alloc(12),
        authTag: Buffer.alloc(16),
        keyVersion: 1,
      }),
    )
    expect(e.code).toBe('23503')
  })
})
