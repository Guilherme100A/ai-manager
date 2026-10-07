// AntibanAdapter (T09, AC-T09-03): todo envio efetivo passa por aqui antes de chegar ao transporte.
// Modo `real` envolve o AntiBan do pacote baileys-antiban (delays, limites, bloqueio de mensagens idênticas).
// Modo `passthrough` só registra e conta (para testes): nunca é o default.
import { AntiBan, type AntiBanInput, type WarmUpState } from 'baileys-antiban'
import { logger as coreLogger } from '../logger'
import type { OutgoingContent } from '../transport'

export const ANTIBAN_MODES = ['real', 'passthrough'] as const
export type AntibanMode = (typeof ANTIBAN_MODES)[number]

export const ANTIBAN_PRESETS = ['conservative', 'moderate', 'aggressive', 'high-volume'] as const
export type AntibanPreset = (typeof ANTIBAN_PRESETS)[number]

export const DEFAULT_ANTIBAN_PRESET: AntibanPreset = 'conservative'

export interface AntibanDecision {
  allowed: boolean
  /** Espera antes do envio (ms). */
  delayMs: number
  reason?: string
}

export interface AntibanStats {
  /** Chamadas a beforeSend. */
  before: number
  allowed: number
  blocked: number
  sent: number
  failed: number
}

/** Interface estável do adapter; a implementação real depende da API do baileys-antiban. */
export interface AntibanAdapter {
  readonly mode: AntibanMode
  beforeSend(key: string, to: string, content: OutgoingContent): Promise<AntibanDecision>
  afterSend(key: string, to: string, content: OutgoingContent, messageId?: string): void
  afterSendFailed(key: string, error?: string): void
  stats(key: string): AntibanStats
}

export interface AntibanLogger {
  warn(obj: object, msg?: string): void
}

/** Subconjunto do `AntiBan` (baileys-antiban v4) usado pelo adapter. */
export interface AntiBanLike {
  beforeSend(recipient: string, content: string): Promise<{ allowed: boolean; delayMs: number; reason?: string }>
  afterSend(recipient: string, content: string, msgId?: string): void
  afterSendFailed(error?: string): void
  destroy?(): void
}

export class AntibanConfigError extends Error {
  readonly code = 'ANTIBAN_CONFIG'
  constructor(message: string) {
    super(message)
    this.name = 'AntibanConfigError'
  }
}

/** ANTIBAN_MODE: ausente/vazio → `real`. Valor inválido lança (nunca desliga o antiban por engano). */
export function antibanModeFromEnv(env: Record<string, string | undefined> = process.env): AntibanMode {
  const raw = env.ANTIBAN_MODE?.trim().toLowerCase()
  if (!raw) return 'real'
  if (!(ANTIBAN_MODES as readonly string[]).includes(raw)) {
    throw new AntibanConfigError(`invalid ANTIBAN_MODE "${env.ANTIBAN_MODE}" (use real or passthrough)`)
  }
  return raw as AntibanMode
}

/** ANTIBAN_PRESET: ausente/vazio → `conservative`. */
export function antibanPresetFromEnv(env: Record<string, string | undefined> = process.env): AntibanPreset {
  const raw = env.ANTIBAN_PRESET?.trim().toLowerCase()
  if (!raw) return DEFAULT_ANTIBAN_PRESET
  if (!(ANTIBAN_PRESETS as readonly string[]).includes(raw)) {
    throw new AntibanConfigError(`invalid ANTIBAN_PRESET "${env.ANTIBAN_PRESET}" (use ${ANTIBAN_PRESETS.join(', ')})`)
  }
  return raw as AntibanPreset
}

/** Texto que o AntiBan usa para detectar repetição: texto/legenda ou uma assinatura estável da mídia. */
export function contentFingerprint(content: OutgoingContent): string {
  if ('text' in content) return content.text
  const caption = 'caption' in content && content.caption ? content.caption : ''
  const kind = Object.keys(content).find((k) => ['image', 'video', 'audio', 'document', 'sticker'].includes(k)) ?? 'media'
  const media = (content as Record<string, { url?: string } | undefined>)[kind]
  return `[${kind}:${media?.url ?? ''}]${caption}`
}

const emptyStats = (): AntibanStats => ({ before: 0, allowed: 0, blocked: 0, sent: 0, failed: 0 })

abstract class BaseAdapter implements AntibanAdapter {
  abstract readonly mode: AntibanMode
  private readonly counters = new Map<string, AntibanStats>()

  protected count(key: string): AntibanStats {
    let s = this.counters.get(key)
    if (!s) {
      s = emptyStats()
      this.counters.set(key, s)
    }
    return s
  }

  stats(key: string): AntibanStats {
    return { ...(this.counters.get(key) ?? emptyStats()) }
  }

  abstract beforeSend(key: string, to: string, content: OutgoingContent): Promise<AntibanDecision>
  abstract afterSend(key: string, to: string, content: OutgoingContent, messageId?: string): void
  abstract afterSendFailed(key: string, error?: string): void
}

export interface BaileysAntibanAdapterOptions {
  /** Preset ou config do AntiBan (default: preset conservative). `logging` fica sempre desligado (sem console). */
  config?: AntiBanInput
  /** Fábrica do AntiBan (injetável em testes). Uma instância por key (sessão). */
  create?: (config: AntiBanInput, warmUp: WarmUpState) => AntiBanLike
}

/**
 * O aquecimento que vale é o nosso (persistido em sessions.warmup_started_at, gate warmupLimit do pipeline).
 * O do AntiBan fica só em memória: a cada restart do worker voltava ao "dia 1" (15 msgs no conservative) e
 * recusava envios que o nosso cronograma liberava, contando como falha. Por isso a instância já nasce graduada
 * e nunca volta ao warm-up por inatividade; ritmo, jitter, mensagens idênticas e saúde do AntiBan seguem valendo.
 */
const NEVER_REWARM_HOURS = 1e9
export function graduatedWarmUp(now = Date.now()): WarmUpState {
  return { startedAt: now - 365 * 86_400_000, lastActiveAt: now, dailyCounts: [], graduated: true }
}

/** Modo real: uma instância do AntiBan por sessão, com o estado de ritmo/limites dela. */
export class BaileysAntibanAdapter extends BaseAdapter {
  readonly mode = 'real' as const
  private readonly instances = new Map<string, AntiBanLike>()
  private readonly config: AntiBanInput
  private readonly create: (config: AntiBanInput, warmUp: WarmUpState) => AntiBanLike

  constructor(opts: BaileysAntibanAdapterOptions = {}) {
    super()
    const base = opts.config ?? DEFAULT_ANTIBAN_PRESET
    const fixed = { logging: false, inactivityThresholdHours: NEVER_REWARM_HOURS }
    this.config = (typeof base === 'string' ? { preset: base, ...fixed } : { ...base, ...fixed }) as AntiBanInput
    this.create = opts.create ?? ((config, warmUp) => new AntiBan(config, warmUp))
  }

  private instance(key: string): AntiBanLike {
    let a = this.instances.get(key)
    if (!a) {
      a = this.create(this.config, graduatedWarmUp())
      this.instances.set(key, a)
    }
    return a
  }

  async beforeSend(key: string, to: string, content: OutgoingContent): Promise<AntibanDecision> {
    const s = this.count(key)
    s.before++
    const d = await this.instance(key).beforeSend(to, contentFingerprint(content))
    if (d.allowed) s.allowed++
    else s.blocked++
    const decision: AntibanDecision = { allowed: d.allowed, delayMs: Math.max(0, d.delayMs || 0) }
    if (d.reason) decision.reason = d.reason
    return decision
  }

  afterSend(key: string, to: string, content: OutgoingContent, messageId?: string): void {
    this.count(key).sent++
    this.instance(key).afterSend(to, contentFingerprint(content), messageId)
  }

  afterSendFailed(key: string, error?: string): void {
    this.count(key).failed++
    this.instance(key).afterSendFailed(error)
  }

  /** Descarta o estado de uma sessão (ex.: sessão removida). */
  forget(key: string): void {
    this.instances.get(key)?.destroy?.()
    this.instances.delete(key)
  }
}

/** Modo passthrough (somente testes): registra e conta, sem esperar e sem bloquear. */
export class PassthroughAntibanAdapter extends BaseAdapter {
  readonly mode = 'passthrough' as const

  constructor(logger: AntibanLogger = coreLogger) {
    super()
    logger.warn({ antiban_mode: 'passthrough' }, 'antiban em passthrough')
  }

  async beforeSend(key: string, _to?: string, _content?: OutgoingContent): Promise<AntibanDecision> {
    const s = this.count(key)
    s.before++
    s.allowed++
    return { allowed: true, delayMs: 0 }
  }

  afterSend(key: string, _to?: string, _content?: OutgoingContent, _messageId?: string): void {
    this.count(key).sent++
  }

  afterSendFailed(key: string, _error?: string): void {
    this.count(key).failed++
  }
}

export interface CreateAntibanAdapterOptions {
  env?: Record<string, string | undefined>
  mode?: AntibanMode
  preset?: AntibanPreset
  /** Config completa do AntiBan (sobrepõe o preset). */
  config?: AntiBanInput
  create?: (config: AntiBanInput, warmUp: WarmUpState) => AntiBanLike
  logger?: AntibanLogger
}

/** Cria o adapter a partir de opções explícitas ou do ambiente (ANTIBAN_MODE, ANTIBAN_PRESET). Default: real/conservative. */
export function createAntibanAdapter(opts: CreateAntibanAdapterOptions = {}): AntibanAdapter {
  const env = opts.env ?? process.env
  const mode = opts.mode ?? antibanModeFromEnv(env)
  if (mode === 'passthrough') return new PassthroughAntibanAdapter(opts.logger)
  const config = opts.config ?? opts.preset ?? antibanPresetFromEnv(env)
  return new BaileysAntibanAdapter(opts.create ? { config, create: opts.create } : { config })
}

let defaultAdapter: AntibanAdapter | undefined

/** Adapter padrão do processo (lazy, a partir do ambiente). Usado pelo `deliver` padrão. */
export function defaultAntibanAdapter(): AntibanAdapter {
  defaultAdapter ??= createAntibanAdapter()
  return defaultAdapter
}

/** Descarta o adapter padrão (testes). */
export function resetDefaultAntibanAdapter(): void {
  defaultAdapter = undefined
}
