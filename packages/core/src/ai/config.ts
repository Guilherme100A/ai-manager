// Configuração da IA assistiva (T13) a partir do ambiente.
export interface AiConfig {
  /** Modelo padrão (AI_MODEL_SMALL). */
  smallModel: string
  /** Modelo usado só quando a confiança do small fica abaixo do limiar (AI_MODEL_LARGE). */
  largeModel: string
  /** Limiar de confiança (0..1) abaixo do qual o large é chamado (AI_CONFIDENCE_THRESHOLD). */
  confidenceThreshold: number
  /** Limite de tokens da resposta (AI_MAX_TOKENS). */
  maxTokens: number
  /** Timeout de cada chamada ao provedor em ms (AI_TIMEOUT_MS). */
  timeoutMs: number
  /** Chave do provedor (AI_PROVIDER_API_KEY). Sem chave, só o fallback determinístico. */
  apiKey: string | undefined
  /** Contexto do negócio/funil (AI_BUSINESS_CONTEXT ou copiado do Espião) injetado no prompt das sugestões. */
  businessContext?: string
}

export const DEFAULT_AI_CONFIG: Readonly<Omit<AiConfig, 'apiKey'>> = Object.freeze({
  smallModel: 'claude-haiku-4-5-20251001',
  largeModel: 'claude-sonnet-5',
  confidenceThreshold: 0.6,
  maxTokens: 512,
  timeoutMs: 10_000,
})

const str = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined)

function num(v: string | undefined, fallback: number, check: (n: number) => boolean): number {
  if (!str(v)) return fallback
  const n = Number(v)
  return Number.isFinite(n) && check(n) ? n : fallback
}

export function aiConfigFromEnv(env: Record<string, string | undefined> = process.env): AiConfig {
  return {
    smallModel: str(env.AI_MODEL_SMALL) ?? DEFAULT_AI_CONFIG.smallModel,
    largeModel: str(env.AI_MODEL_LARGE) ?? DEFAULT_AI_CONFIG.largeModel,
    confidenceThreshold: num(env.AI_CONFIDENCE_THRESHOLD, DEFAULT_AI_CONFIG.confidenceThreshold, (n) => n >= 0 && n <= 1),
    maxTokens: Math.floor(num(env.AI_MAX_TOKENS, DEFAULT_AI_CONFIG.maxTokens, (n) => n >= 1)),
    timeoutMs: num(env.AI_TIMEOUT_MS, DEFAULT_AI_CONFIG.timeoutMs, (n) => n > 0),
    apiKey: str(env.AI_PROVIDER_API_KEY),
    businessContext: str(env.AI_BUSINESS_CONTEXT),
  }
}

export function resolveAiConfig(partial: Partial<AiConfig> = {}): AiConfig {
  const defined = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)) as Partial<AiConfig>
  return { ...DEFAULT_AI_CONFIG, apiKey: undefined, ...defined }
}
