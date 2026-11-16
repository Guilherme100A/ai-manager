// Configurações do LLM da IA assistiva (T19): linha única em `ai_settings`, com prioridade campo a campo sobre o
// ambiente do T13 (AI_*). A chave do provedor fica só cifrada (cripto do T02) e nunca sai numa view pública.
import { eq } from 'drizzle-orm'
import { aiSettings, type Database } from '@wsm/db'
import { getCredentialsCipher, type CredentialCipher } from '../crypto'
import { aiConfigFromEnv, type AiConfig } from './config'
import { createAiProvider, type AiProvider } from './provider'

export const AI_PROVIDERS = ['anthropic'] as const
export type AiProviderName = (typeof AI_PROVIDERS)[number]

/** Limites seguros aceitos na configuração (validação da API e da leitura). */
export const AI_SETTINGS_LIMITS = Object.freeze({
  model: { min: 1, max: 200 },
  apiKey: { min: 1, max: 500 },
  maxTokens: { min: 1, max: 8192 },
  timeoutMs: { min: 500, max: 120_000 },
  confidenceThreshold: { min: 0, max: 1 },
})

export const AI_SETTINGS_FIELDS = ['provider', 'apiKey', 'modelSmall', 'modelLarge', 'confidenceThreshold', 'maxTokens', 'timeoutMs', 'enabled'] as const
export type AiSettingsField = (typeof AI_SETTINGS_FIELDS)[number]
export type AiSettingsSource = 'db' | 'env'

/** Alteração parcial: campo omitido mantém; `null` volta a usar o ambiente (em apiKey, remove a chave do banco). */
export interface AiSettingsInput {
  provider?: AiProviderName | null
  apiKey?: string | null
  modelSmall?: string | null
  modelLarge?: string | null
  confidenceThreshold?: number | null
  maxTokens?: number | null
  timeoutMs?: number | null
  enabled?: boolean | null
}

/** Configuração efetiva (interna: contém a chave em claro; nunca devolver pela API). */
export interface ResolvedAiSettings {
  provider: AiProviderName
  enabled: boolean
  config: AiConfig
  sources: Record<AiSettingsField, AiSettingsSource>
  updatedAt: Date | null
}

/** Visão pública (GET /api/ai/settings). */
export interface AiSettingsView {
  provider: AiProviderName
  modelSmall: string
  modelLarge: string
  confidenceThreshold: number
  maxTokens: number
  timeoutMs: number
  enabled: boolean
  hasApiKey: boolean
  updatedAt: string | null
  sources: Record<AiSettingsField, AiSettingsSource>
}

export type AiSettingsRow = typeof aiSettings.$inferSelect

export const AI_SETTINGS_ID = 1
export const AI_SETTINGS_AAD = 'ai_settings/api_key'

/** AI_ENABLED: ausente → true; false/0/no/off → false. */
export function aiEnabledFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.AI_ENABLED?.trim().toLowerCase()
  if (!v) return true
  return !['false', '0', 'no', 'off'].includes(v)
}

/** Mescla banco (não nulo) sobre ambiente, campo a campo. `apiKey` é a chave já decifrada do banco. */
export function resolveAiSettings(
  row: (Omit<Partial<AiSettingsRow>, 'provider'> & { provider?: string | null }) | undefined,
  env: Record<string, string | undefined> = process.env,
  dbApiKey?: string | null,
): ResolvedAiSettings {
  const base = aiConfigFromEnv(env)
  const sources = {} as Record<AiSettingsField, AiSettingsSource>
  const pick = <T>(field: AiSettingsField, dbValue: T | null | undefined, envValue: T): T => {
    const fromDb = dbValue !== null && dbValue !== undefined
    sources[field] = fromDb ? 'db' : 'env'
    return fromDb ? dbValue : envValue
  }
  const provider = pick<AiProviderName>('provider', (row?.provider as AiProviderName | null | undefined) ?? null, 'anthropic')
  const apiKey = pick<string | undefined>('apiKey', dbApiKey ?? null, base.apiKey)
  const config: AiConfig = {
    smallModel: pick('modelSmall', row?.modelSmall, base.smallModel),
    largeModel: pick('modelLarge', row?.modelLarge, base.largeModel),
    confidenceThreshold: pick('confidenceThreshold', row?.confidenceThreshold, base.confidenceThreshold),
    maxTokens: pick('maxTokens', row?.maxTokens, base.maxTokens),
    timeoutMs: pick('timeoutMs', row?.timeoutMs, base.timeoutMs),
    apiKey,
    // Contexto do funil: banco tem prioridade sobre o ambiente; não entra em `sources` (não é campo do painel de IA).
    ...((row?.businessContext ?? base.businessContext) ? { businessContext: (row?.businessContext ?? base.businessContext) ?? undefined } : {}),
  }
  const enabled = pick('enabled', row?.enabled, aiEnabledFromEnv(env))
  return { provider, enabled, config, sources, updatedAt: row?.updatedAt ?? null }
}

export function toAiSettingsView(s: ResolvedAiSettings): AiSettingsView {
  return {
    provider: s.provider,
    modelSmall: s.config.smallModel,
    modelLarge: s.config.largeModel,
    confidenceThreshold: s.config.confidenceThreshold,
    maxTokens: s.config.maxTokens,
    timeoutMs: s.config.timeoutMs,
    enabled: s.enabled,
    hasApiKey: Boolean(s.config.apiKey),
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
    sources: { ...s.sources },
  }
}

/** Aplica uma alteração parcial em memória (usado pelo teste de conexão, que não salva). */
export function applyAiSettingsInput(s: ResolvedAiSettings, input: AiSettingsInput, env: Record<string, string | undefined> = process.env): ResolvedAiSettings {
  const base = aiConfigFromEnv(env)
  const next: ResolvedAiSettings = { ...s, config: { ...s.config }, sources: { ...s.sources } }
  const set = <K extends AiSettingsField>(field: K, value: unknown, apply: (v: never, fromEnv: boolean) => void) => {
    if (value === undefined) return
    next.sources[field] = value === null ? 'env' : 'db'
    apply(value as never, value === null)
  }
  set('provider', input.provider, (v: AiProviderName | null) => (next.provider = v ?? 'anthropic'))
  set('apiKey', input.apiKey, (v: string | null) => (next.config.apiKey = v ?? base.apiKey))
  set('modelSmall', input.modelSmall, (v: string | null) => (next.config.smallModel = v ?? base.smallModel))
  set('modelLarge', input.modelLarge, (v: string | null) => (next.config.largeModel = v ?? base.largeModel))
  set('confidenceThreshold', input.confidenceThreshold, (v: number | null) => (next.config.confidenceThreshold = v ?? base.confidenceThreshold))
  set('maxTokens', input.maxTokens, (v: number | null) => (next.config.maxTokens = v ?? base.maxTokens))
  set('timeoutMs', input.timeoutMs, (v: number | null) => (next.config.timeoutMs = v ?? base.timeoutMs))
  set('enabled', input.enabled, (v: boolean | null) => (next.enabled = v ?? aiEnabledFromEnv(env)))
  return next
}

export class InvalidAiSettingsError extends Error {
  readonly code = 'VALIDATION_ERROR'
  constructor(
    readonly field: AiSettingsField,
    message: string,
  ) {
    super(message)
    this.name = 'InvalidAiSettingsError'
  }
}

/** Validação de domínio (a API valida antes com zod; isto protege outros chamadores). */
export function validateAiSettingsInput(input: AiSettingsInput): void {
  const L = AI_SETTINGS_LIMITS
  const bad = (field: AiSettingsField, msg: string) => {
    throw new InvalidAiSettingsError(field, `${field}: ${msg}`)
  }
  if (input.provider != null && !(AI_PROVIDERS as readonly string[]).includes(input.provider)) bad('provider', `must be one of ${AI_PROVIDERS.join(', ')}`)
  for (const f of ['modelSmall', 'modelLarge'] as const) {
    const v = input[f]
    if (v != null && (typeof v !== 'string' || v.trim().length < L.model.min || v.trim().length > L.model.max)) bad(f, 'must be a non-empty model name')
  }
  if (input.apiKey != null && (typeof input.apiKey !== 'string' || input.apiKey.trim().length < L.apiKey.min || input.apiKey.length > L.apiKey.max)) {
    bad('apiKey', 'invalid api key')
  }
  const t = input.confidenceThreshold
  if (t != null && !(typeof t === 'number' && t >= 0 && t <= 1)) bad('confidenceThreshold', 'must be between 0 and 1')
  const intIn = (f: 'maxTokens' | 'timeoutMs', v: number | null | undefined, min: number, max: number) => {
    if (v != null && !(Number.isInteger(v) && v >= min && v <= max)) bad(f, `must be an integer between ${min} and ${max}`)
  }
  intIn('maxTokens', input.maxTokens, L.maxTokens.min, L.maxTokens.max)
  intIn('timeoutMs', input.timeoutMs, L.timeoutMs.min, L.timeoutMs.max)
  if (input.enabled != null && typeof input.enabled !== 'boolean') bad('enabled', 'must be a boolean')
}

export interface AiSettingsServiceOptions {
  db: Database
  /** Ambiente de fallback (default process.env). */
  env?: Record<string, string | undefined>
  cipher?: CredentialCipher
}

export interface AiSettingsUpdateResult {
  view: AiSettingsView
  /** Campos presentes na alteração. */
  fields: AiSettingsField[]
  apiKey: 'set' | 'removed' | 'unchanged'
}

export class AiSettingsService {
  readonly db: Database
  private readonly env: Record<string, string | undefined>
  private readonly cipherOpt: CredentialCipher | undefined

  constructor(opts: AiSettingsServiceOptions) {
    this.db = opts.db
    this.env = opts.env ?? process.env
    this.cipherOpt = opts.cipher
  }

  private cipher(): CredentialCipher {
    return this.cipherOpt ?? getCredentialsCipher()
  }

  private async row(): Promise<AiSettingsRow | undefined> {
    const [row] = await this.db.select().from(aiSettings).where(eq(aiSettings.id, AI_SETTINGS_ID))
    return row
  }

  private decryptKey(row: AiSettingsRow | undefined): string | null {
    if (!row?.apiKeyCiphertext || !row.apiKeyIv || !row.apiKeyAuthTag || row.apiKeyKeyVersion == null) return null
    return this.cipher().decrypt<string>(
      { ciphertext: row.apiKeyCiphertext, iv: row.apiKeyIv, authTag: row.apiKeyAuthTag, keyVersion: row.apiKeyKeyVersion },
      { aad: AI_SETTINGS_AAD },
    )
  }

  /** Configuração efetiva, com a chave em claro (uso interno do worker e do teste de conexão). */
  async resolve(): Promise<ResolvedAiSettings> {
    const row = await this.row()
    return resolveAiSettings(row, this.env, this.decryptKey(row))
  }

  /** Visão pública: sem a chave. */
  async get(): Promise<AiSettingsView> {
    return toAiSettingsView(await this.resolve())
  }

  async update(input: AiSettingsInput): Promise<AiSettingsUpdateResult> {
    validateAiSettingsInput(input)
    const fields = AI_SETTINGS_FIELDS.filter((f) => input[f] !== undefined)
    const set: Partial<typeof aiSettings.$inferInsert> = { updatedAt: new Date() }
    if (input.provider !== undefined) set.provider = input.provider
    if (input.modelSmall !== undefined) set.modelSmall = input.modelSmall?.trim() ?? null
    if (input.modelLarge !== undefined) set.modelLarge = input.modelLarge?.trim() ?? null
    if (input.confidenceThreshold !== undefined) set.confidenceThreshold = input.confidenceThreshold
    if (input.maxTokens !== undefined) set.maxTokens = input.maxTokens
    if (input.timeoutMs !== undefined) set.timeoutMs = input.timeoutMs
    if (input.enabled !== undefined) set.enabled = input.enabled
    let apiKey: AiSettingsUpdateResult['apiKey'] = 'unchanged'
    if (input.apiKey === null) {
      Object.assign(set, { apiKeyCiphertext: null, apiKeyIv: null, apiKeyAuthTag: null, apiKeyKeyVersion: null })
      apiKey = 'removed'
    } else if (input.apiKey !== undefined) {
      const enc = this.cipher().encrypt(input.apiKey.trim(), { aad: AI_SETTINGS_AAD })
      Object.assign(set, { apiKeyCiphertext: enc.ciphertext, apiKeyIv: enc.iv, apiKeyAuthTag: enc.authTag, apiKeyKeyVersion: enc.keyVersion })
      apiKey = 'set'
    }
    await this.db
      .insert(aiSettings)
      .values({ id: AI_SETTINGS_ID, ...set })
      .onConflictDoUpdate({ target: aiSettings.id, set })
    return { view: await this.get(), fields, apiKey }
  }

  /** Define (ou limpa com null) o contexto do negócio/funil que guia as sugestões da IA. */
  async setBusinessContext(text: string | null): Promise<{ chars: number }> {
    const value = text?.trim() ? text.trim().slice(0, MAX_BUSINESS_CONTEXT) : null
    const set = { businessContext: value, updatedAt: new Date() }
    await this.db.insert(aiSettings).values({ id: AI_SETTINGS_ID, ...set }).onConflictDoUpdate({ target: aiSettings.id, set })
    return { chars: value?.length ?? 0 }
  }
}

/** Teto do contexto do negócio guardado: evita estourar o prompt das sugestões. */
export const MAX_BUSINESS_CONTEXT = 12_000

/** Fábrica do provedor a partir da chave (default: SDK oficial da Anthropic). */
export type AiProviderFactory = (apiKey: string) => AiProvider | undefined

export interface AiConnectionTestResult {
  ok: boolean
  model: string
  latencyMs: number
  error?: string
}

/** Remove a chave (e prefixos típicos de chave) da mensagem de erro e limita o tamanho. */
export function sanitizeAiError(err: unknown, apiKey?: string): string {
  let msg = err instanceof Error ? err.message : String(err)
  if (apiKey) msg = msg.split(apiKey).join('[redacted]')
  msg = msg.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
  return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg
}

/** Chamada mínima ao provedor com a configuração informada. Nunca lança; nunca devolve a chave. */
export async function testAiProvider(
  settings: ResolvedAiSettings,
  factory: AiProviderFactory = createAiProvider,
  now: () => number = () => performance.now(),
): Promise<AiConnectionTestResult> {
  const model = settings.config.smallModel
  const apiKey = settings.config.apiKey
  if (!apiKey) return { ok: false, model, latencyMs: 0, error: 'no api key configured' }
  const started = now()
  const timeoutMs = settings.config.timeoutMs
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const provider = factory(apiKey)
    if (!provider) return { ok: false, model, latencyMs: 0, error: 'provider not available' }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`provider timeout after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    await Promise.race([provider.generate({ model, maxTokens: Math.min(settings.config.maxTokens, 64), text: 'ping', signal: controller.signal }), timeout])
    return { ok: true, model, latencyMs: Math.round(now() - started) }
  } catch (err) {
    return { ok: false, model, latencyMs: Math.round(now() - started), error: sanitizeAiError(err, apiKey) }
  } finally {
    clearTimeout(timer)
  }
}
