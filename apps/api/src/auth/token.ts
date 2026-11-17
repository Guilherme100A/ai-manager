// Token de login do painel (AC-T17-02): `wsm1.<payload base64url>.<HMAC-SHA256 base64url>`.
// Opaco para o cliente; a validade é conferida pela assinatura e pelo `exp` (sem estado, exceto revogação).
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export const TOKEN_PREFIX = 'wsm1'

export interface TokenClaims {
  /** Usuário. */
  sub: string
  role: 'admin'
  /** Emitido em (epoch ms). */
  iat: number
  /** Expira em (epoch ms). */
  exp: number
  /** Id único do token (revogação). */
  jti: string
  /** Remembered sessions require a live database record on every authenticated request. */
  remember?: true
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url')
const sign = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest()

export function isLoginToken(token: string): boolean {
  return token.startsWith(`${TOKEN_PREFIX}.`)
}

export function signToken(secret: string, claims: Omit<TokenClaims, 'jti'> & { jti?: string }): string {
  const full: TokenClaims = { ...claims, jti: claims.jti ?? randomUUID() }
  const body = `${TOKEN_PREFIX}.${b64url(JSON.stringify(full))}`
  return `${body}.${b64url(sign(secret, body))}`
}

/** Confere formato e assinatura (tempo constante). Não olha expiração nem revogação. */
export function verifySignature(secret: string, token: string): TokenClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return undefined
  const [, payload, signature] = parts as [string, string, string]
  // Compara a forma codificada: decodificar base64url ignoraria os bits de preenchimento do último caractere
  // (um token com o último caractere trocado passaria).
  const expected = Buffer.from(b64url(sign(secret, `${TOKEN_PREFIX}.${payload}`)))
  const given = Buffer.from(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<TokenClaims>
    if (typeof claims.sub !== 'string' || claims.role !== 'admin' || typeof claims.exp !== 'number' || typeof claims.jti !== 'string') {
      return undefined
    }
    if (claims.remember !== undefined && claims.remember !== true) return undefined
    return claims as TokenClaims
  } catch {
    return undefined
  }
}
