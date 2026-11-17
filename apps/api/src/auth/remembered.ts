import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { dashboardLoginSessions, type Database } from '@wsm/db'
import type { TokenClaims } from './token'

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export async function rememberLogin(db: Database, token: string, claims: TokenClaims): Promise<void> {
  await db.insert(dashboardLoginSessions).values({
    id: claims.jti, tokenHash: hash(token), username: claims.sub,
    createdAt: new Date(claims.iat), expiresAt: new Date(claims.exp),
  })
}

/** Signature/expiry is checked by AuthService first; absent, revoked or mismatched rows fail closed. */
export async function rememberedLoginActive(db: Database, token: string, claims: TokenClaims): Promise<boolean> {
  const [row] = await db.select({ id: dashboardLoginSessions.id }).from(dashboardLoginSessions).where(and(
    eq(dashboardLoginSessions.id, claims.jti), eq(dashboardLoginSessions.tokenHash, hash(token)),
    eq(dashboardLoginSessions.username, claims.sub), eq(dashboardLoginSessions.expiresAt, new Date(claims.exp)),
    isNull(dashboardLoginSessions.revokedAt),
  )).limit(1)
  return !!row
}

export async function revokeRememberedLogin(db: Database, token: string, claims: TokenClaims): Promise<void> {
  await db.update(dashboardLoginSessions).set({ revokedAt: new Date() }).where(and(
    eq(dashboardLoginSessions.id, claims.jti), eq(dashboardLoginSessions.tokenHash, hash(token)),
  ))
}
