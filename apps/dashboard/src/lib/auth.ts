// Default: memory/sessionStorage. Explicit remember opt-in persists only token + expiry, never a password.
export const TOKEN_KEY = 'wsm.token'
export const REMEMBERED_TOKEN_KEY = 'wsm.remembered-session'

let memory: string | null = null
const listeners = new Set<() => void>()

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

export function getToken(): string | null {
  if (memory) return memory
  try {
    memory = storage()?.getItem(TOKEN_KEY) ?? null
  } catch { memory = null }
  if (!memory) {
    try {
      const raw = globalThis.localStorage?.getItem(REMEMBERED_TOKEN_KEY)
      if (raw) {
        try {
          const value = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown }
          if (typeof value.token === 'string' && value.token && typeof value.expiresAt === 'string' && Date.parse(value.expiresAt) > Date.now()) {
            memory = value.token
            try { storage()?.setItem(TOKEN_KEY, memory) } catch { /* memory still works */ }
          } else globalThis.localStorage?.removeItem(REMEMBERED_TOKEN_KEY)
        } catch { globalThis.localStorage?.removeItem(REMEMBERED_TOKEN_KEY) }
      }
    } catch { /* persistent storage can be disabled */ }
  }
  return memory
}

export function setToken(token: string, options: { remember: true; expiresAt: string } | { remember?: false } = {}): void {
  memory = token
  try {
    storage()?.setItem(TOKEN_KEY, token)
  } catch {
    // sem sessionStorage (modo privado): fica só em memória
  }
  try {
    if (options.remember && Date.parse(options.expiresAt) > Date.now()) {
      globalThis.localStorage?.setItem(REMEMBERED_TOKEN_KEY, JSON.stringify({ token, expiresAt: options.expiresAt }))
    } else globalThis.localStorage?.removeItem(REMEMBERED_TOKEN_KEY)
  } catch { /* blocked persistent storage: retain the current session */ }
  for (const l of listeners) l()
}

export function clearToken(expectedToken?: string): void {
  // A delayed 401 for a previous login must not clear a newer login.
  if (expectedToken && getToken() !== expectedToken) return
  memory = null
  try {
    storage()?.removeItem(TOKEN_KEY)
  } catch {
    // ignore
  }
  try {
    const raw = globalThis.localStorage?.getItem(REMEMBERED_TOKEN_KEY)
    if (!expectedToken || (raw && JSON.parse(raw).token === expectedToken)) globalThis.localStorage?.removeItem(REMEMBERED_TOKEN_KEY)
  } catch { /* ignore */ }
  for (const l of listeners) l()
}

export function onTokenChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
