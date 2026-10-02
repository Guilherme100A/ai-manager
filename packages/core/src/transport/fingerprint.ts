import { createHash } from 'node:crypto'

/** Descritor que o Baileys envia como "aparelho": [SO, navegador, versão]. */
export type BrowserDescription = [string, string, string]

const OS_POOL = ['Ubuntu', 'Mac OS', 'Windows'] as const
const BROWSER_POOL = ['Chrome', 'Firefox', 'Edge', 'Opera', 'Brave'] as const
const VERSION_POOL = [
  '120.0.0.0', '121.0.0.0', '122.0.0.0', '124.0.0.0',
  '125.0.0.0', '126.0.0.0', '128.0.0.0', '130.0.0.0',
] as const

const pick = <T>(pool: readonly T[], byte: number): T => pool[byte % pool.length]!

/**
 * Fingerprint (browser) estável e distinto por sessão. Deriva de um hash do
 * sessionId: o mesmo id gera sempre o mesmo descritor (estável entre
 * reconexões) e ids diferentes caem em combinações diferentes.
 */
export function browserForSession(sessionId: string): BrowserDescription {
  const h = createHash('sha256').update(sessionId).digest()
  return [pick(OS_POOL, h[0] ?? 0), pick(BROWSER_POOL, h[1] ?? 0), pick(VERSION_POOL, h[2] ?? 0)]
}
