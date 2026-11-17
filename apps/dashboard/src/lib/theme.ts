// Tema claro/escuro (T21): <html data-theme>. Sem escolha salva, segue prefers-color-scheme.
// Preferencia visual no localStorage ('wsm.theme'), independente da opcao de lembrar login.
export type Theme = 'light' | 'dark'

export const THEME_KEY = 'wsm.theme'

const listeners = new Set<() => void>()

export function parseTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' ? value : null
}

export function resolveTheme(stored: Theme | null, prefersDark: boolean): Theme {
  return stored ?? (prefersDark ? 'dark' : 'light')
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark'
}

export function readStoredTheme(): Theme | null {
  try {
    return parseTheme(globalThis.localStorage?.getItem(THEME_KEY))
  } catch {
    return null
  }
}

function darkQuery(): MediaQueryList | undefined {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : undefined
}

export function getTheme(): Theme {
  return parseTheme(document.documentElement.dataset.theme) ?? resolveTheme(readStoredTheme(), !!darkQuery()?.matches)
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme
  for (const cb of listeners) cb()
}

/** Escolha explícita do usuário: aplica e grava. */
export function setTheme(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, theme)
  } catch {
    // sem localStorage (modo privado): vale só nesta página
  }
  apply(theme)
}

export function toggleTheme(): void {
  setTheme(nextTheme(getTheme()))
}

/** Aplica o tema inicial e acompanha o sistema enquanto não houver escolha salva. */
export function initTheme(): void {
  const query = darkQuery()
  apply(resolveTheme(readStoredTheme(), !!query?.matches))
  query?.addEventListener('change', (e) => {
    if (!readStoredTheme()) apply(e.matches ? 'dark' : 'light')
  })
}

export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
