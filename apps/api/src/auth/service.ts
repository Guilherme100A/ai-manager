// Login de administrador do painel (AC-T17-01/02): usuário/senha do ambiente, token assinado com expiração,
// revogação no logout e limite de tentativas por IP.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { signToken, verifySignature, type TokenClaims } from './token'

export const DEFAULT_ADMIN_USERNAME = 'admin'
export const DEFAULT_ADMIN_PASSWORD = 'nimda'
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_LOGIN_MAX_FAILURES = 5
export const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000

/** Opções injetáveis (deps.auth). Precedência: deps.auth > env > default. */
export interface AuthOptions {
  username?: string
  password?: string
  secret?: string
  sessionTtlMs?: number
  now?: () => Date
  loginMaxFailures?: number
  loginWindowMs?: number
  /** Confiar em x-forwarded-for para o IP do limite de tentativas (só atrás de um proxy que sobrescreve o header). Env TRUST_PROXY. Default false. */
  trustProxy?: boolean
}

export interface AuthLogger {
  warn(obj: object, msg?: string): void
}

export interface AuthUser {
  username: string
  role: 'admin'
}

export interface LoginResult {
  token: string
  expiresAt: string
  user: AuthUser
}

export type LoginOutcome = { ok: true; result: LoginResult } | { ok: false; reason: 'invalid_credentials' | 'rate_limited' }

export interface ResolvedAuthConfig {
  username: string
  password: string
  secret: string
  sessionTtlMs: number
  loginMaxFailures: number
  loginWindowMs: number
  trustProxy: boolean
  /** A senha veio do default (ADMIN_PASSWORD ausente). */
  defaultPassword: boolean
  /** O segredo foi gerado neste processo (AUTH_SECRET ausente). */
  generatedSecret: boolean
}

const str = (v: string | undefined) => (v !== undefined && v !== '' ? v : undefined)
const positive = (v: string | undefined) => {
  const n = Number(v)
  return str(v) && Number.isFinite(n) && n > 0 ? n : undefined
}

export function resolveAuthConfig(opts: AuthOptions = {}, env: Record<string, string | undefined> = process.env): ResolvedAuthConfig {
  const password = opts.password ?? str(env.ADMIN_PASSWORD)
  const secret = opts.secret ?? str(env.AUTH_SECRET)
  return {
    username: opts.username ?? str(env.ADMIN_USERNAME) ?? DEFAULT_ADMIN_USERNAME,
    password: password ?? DEFAULT_ADMIN_PASSWORD,
    secret: secret ?? randomBytes(32).toString('base64url'),
    sessionTtlMs: opts.sessionTtlMs ?? positive(env.AUTH_SESSION_TTL_MS) ?? DEFAULT_SESSION_TTL_MS,
    loginMaxFailures: opts.loginMaxFailures ?? DEFAULT_LOGIN_MAX_FAILURES,
    loginWindowMs: opts.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS,
    trustProxy: opts.trustProxy ?? isTrue(env.TRUST_PROXY),
    defaultPassword: password === undefined,
    generatedSecret: secret === undefined,
  }
}

/** 'true' | '1' | 'yes' (sem diferenciar maiúsculas). */
export const isTrue = (v: string | undefined) => ['true', '1', 'yes'].includes((v ?? '').trim().toLowerCase())

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()
/** Igualdade em tempo constante (independe do tamanho das entradas). */
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

export class AuthService {
  readonly config: ResolvedAuthConfig
  private readonly now: () => Date
  private readonly failures = new Map<string, number[]>()
  /** jti revogado → expiração (epoch ms); some da lista quando o token expira. */
  private readonly revoked = new Map<string, number>()

  constructor(opts: AuthOptions = {}, env: Record<string, string | undefined> = process.env, logger?: AuthLogger) {
    this.config = resolveAuthConfig(opts, env)
    this.now = opts.now ?? (() => new Date())
    if (this.config.defaultPassword) {
      logger?.warn({ component: 'auth' }, 'ADMIN_PASSWORD not set: using the default admin password; set ADMIN_PASSWORD in production')
    }
    if (this.config.generatedSecret) {
      logger?.warn({ component: 'auth' }, 'AUTH_SECRET not set: generated a random secret; login tokens stop working after a restart')
    }
  }

  /** Confere usuário e senha (tempo constante; mesma resposta para usuário ou senha errados). */
  login(username: string, password: string, ip: string, remember = false): LoginOutcome {
    const nowMs = this.now().getTime()
    if (this.recentFailures(ip, nowMs) >= this.config.loginMaxFailures) return { ok: false, reason: 'rate_limited' }
    // Avalia os dois sempre (sem curto-circuito) para não vazar qual campo errou pelo tempo.
    const userOk = safeEqual(username, this.config.username)
    const passOk = safeEqual(password, this.config.password)
    if (!(userOk && passOk)) {
      this.failures.set(ip, [...(this.failures.get(ip) ?? []), nowMs])
      return { ok: false, reason: 'invalid_credentials' }
    }
    this.failures.delete(ip)
    const exp = nowMs + (remember ? REMEMBERED_SESSION_TTL_MS : this.config.sessionTtlMs)
    const token = signToken(this.config.secret, { sub: this.config.username, role: 'admin', iat: nowMs, exp, ...(remember ? { remember: true as const } : {}) })
    return { ok: true, result: { token, expiresAt: new Date(exp).toISOString(), user: { username: this.config.username, role: 'admin' } } }
  }

  /** Claims de um token de login válido (assinatura, expiração e revogação); senão undefined. */
  verify(token: string): TokenClaims | undefined {
    const claims = verifySignature(this.config.secret, token)
    if (!claims) return undefined
    const nowMs = this.now().getTime()
    if (claims.exp <= nowMs) return undefined
    if (claims.remember && (claims.sub !== this.config.username || !Number.isFinite(claims.iat) || claims.exp <= claims.iat || claims.exp - claims.iat > REMEMBERED_SESSION_TTL_MS)) return undefined
    if (this.revoked.has(claims.jti)) return undefined
    return claims
  }

  /** Revoga o token até a expiração dele. Token inválido é ignorado. */
  revoke(token: string): boolean {
    const claims = this.verify(token)
    if (!claims) return false
    this.revoked.set(claims.jti, claims.exp)
    this.prune()
    return true
  }

  private recentFailures(ip: string, nowMs: number): number {
    const list = (this.failures.get(ip) ?? []).filter((t) => nowMs - t < this.config.loginWindowMs)
    if (list.length) this.failures.set(ip, list)
    else this.failures.delete(ip)
    return list.length
  }

  private prune(): void {
    const nowMs = this.now().getTime()
    for (const [jti, exp] of this.revoked) if (exp <= nowMs) this.revoked.delete(jti)
  }
}
