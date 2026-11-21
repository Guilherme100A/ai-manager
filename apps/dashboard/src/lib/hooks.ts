import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getToken, onTokenChange } from './auth'
import { parseHash, subscribeRoute, type Route } from './router'

/** Intervalos de polling (ms). */
export const POLL = { fast: 1000, list: 3000, page: 5000 } as const

export interface PollState<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  reload: () => void
}

/** Busca `fn` agora e a cada `intervalMs` (0 = uma vez). Ignora respostas obsoletas. */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []): PollState<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      try {
        const value = await fnRef.current()
        if (!alive) return
        setData(value)
        setError(undefined)
      } catch (err) {
        if (!alive) return
        setError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        if (alive) {
          setLoading(false)
          if (intervalMs > 0) timer = setTimeout(run, intervalMs)
        }
      }
    }
    void run()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [intervalMs, tick, ...deps])

  return { data, error, loading, reload }
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeRoute, () => window.location.hash, () => '')
  return parseHash(hash)
}

export function useToken(): string | null {
  return useSyncExternalStore(onTokenChange, getToken, () => null)
}
