// Registro leve do que o worker está fazendo (mensagens recebidas, ciclos, consultas). Quando o event loop trava,
// o resumo dos segundos anteriores vai junto do travamento: é a pista do que causou a parada.
export interface ActivityLog {
  mark(label: string): void
  /** Contagem por rótulo entre `from` e `to` (ms), maiores primeiro. */
  summary(from: number, to: number): Record<string, number>
}

export const ACTIVITY_CAPACITY = 2000

export function createActivityLog(now: () => number = Date.now, capacity = ACTIVITY_CAPACITY): ActivityLog {
  const at: number[] = new Array(capacity)
  const labels: string[] = new Array(capacity)
  let next = 0
  let size = 0
  return {
    mark(label) {
      at[next] = now()
      labels[next] = label
      next = (next + 1) % capacity
      size = Math.min(size + 1, capacity)
    },
    summary(from, to) {
      const counts: Record<string, number> = {}
      for (let i = 0; i < size; i++) {
        const t = at[i]!
        if (t >= from && t <= to) counts[labels[i]!] = (counts[labels[i]!] ?? 0) + 1
      }
      return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]))
    },
  }
}
