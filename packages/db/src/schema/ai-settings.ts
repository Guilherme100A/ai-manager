import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgTable, real, smallint, text, timestamp } from 'drizzle-orm/pg-core'
import { bytea } from './bytea.js'

// Configuração do LLM da IA assistiva (T19): linha única (id = 1). Cada coluna NULL = vale o ambiente (AI_*).
// A chave do provedor só existe cifrada (AES-256-GCM, cripto do T02); nunca em texto puro.
export const aiSettings = pgTable(
  'ai_settings',
  {
    id: smallint('id').primaryKey().default(1),
    provider: text('provider'),
    apiKeyCiphertext: bytea('api_key_ciphertext'),
    apiKeyIv: bytea('api_key_iv'),
    apiKeyAuthTag: bytea('api_key_auth_tag'),
    apiKeyKeyVersion: integer('api_key_key_version'),
    modelSmall: text('model_small'),
    modelLarge: text('model_large'),
    confidenceThreshold: real('confidence_threshold'),
    maxTokens: integer('max_tokens'),
    timeoutMs: integer('timeout_ms'),
    enabled: boolean('enabled'),
    // Contexto do negócio/funil que guia as sugestões da IA (ex.: funil copiado do Espião). Texto livre; null = sem.
    businessContext: text('business_context'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ai_settings_singleton_check', sql`${t.id} = 1`),
    check('ai_settings_threshold_check', sql`${t.confidenceThreshold} is null or (${t.confidenceThreshold} >= 0 and ${t.confidenceThreshold} <= 1)`),
    check('ai_settings_limits_check', sql`(${t.maxTokens} is null or ${t.maxTokens} >= 1) and (${t.timeoutMs} is null or ${t.timeoutMs} >= 1)`),
  ],
)
