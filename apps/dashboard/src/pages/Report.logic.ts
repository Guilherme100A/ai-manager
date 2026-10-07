// Regras de leitura do relatório diário: o que merece atenção em cada linha (sem React, testável).
import type { ReportDayRow } from '../lib/types'

export type ReportLevel = 'alert' | 'warn'
export interface ReportFlag {
  level: ReportLevel
  text: string
}

/** Quedas num dia a partir das quais vale olhar (rotina do WhatsApp fica abaixo disso). */
export const DISCONNECTS_WARN = 3

export function rowFlags(r: ReportDayRow): ReportFlag[] {
  const flags: ReportFlag[] = []
  if (r.blocked > 0) flags.push({ level: 'alert', text: `${r.blocked} sinal(is) de bloqueio (401/403)` })
  if (r.failed > 0) flags.push({ level: 'alert', text: `${r.failed} falha(s) de envio` })
  if (r.disconnects >= DISCONNECTS_WARN) flags.push({ level: 'warn', text: `${r.disconnects} quedas no dia` })
  if (r.disconnectsNearStall > 0) flags.push({ level: 'warn', text: `${r.disconnectsNearStall} queda(s) logo após travamento do worker` })
  if (r.proxyUnavailable > 0) flags.push({ level: 'warn', text: `proxy caiu ${r.proxyUnavailable}x` })
  if (r.degraded > 0) flags.push({ level: 'warn', text: `entrou em DEGRADED ${r.degraded}x` })
  return flags
}

/** "428×3 · 503×1", maior primeiro; "—" sem quedas. */
export function formatCodes(codes: Record<string, number>): string {
  const parts = Object.entries(codes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return parts.length ? parts.map(([code, n]) => `${code}×${n}`).join(' · ') : '—'
}

export interface ReportTotals {
  sent: number
  failed: number
  received: number
  disconnects: number
  blocked: number
  groupsJoined: number
}

export function totalsBySession(rows: ReportDayRow[]): Map<string, ReportTotals> {
  const out = new Map<string, ReportTotals>()
  for (const r of rows) {
    const t = out.get(r.sessionId) ?? { sent: 0, failed: 0, received: 0, disconnects: 0, blocked: 0, groupsJoined: 0 }
    t.sent += r.sent
    t.failed += r.failed
    t.received += r.received
    t.disconnects += r.disconnects
    t.blocked += r.blocked
    t.groupsJoined += r.groupsJoined
    out.set(r.sessionId, t)
  }
  return out
}

/** 2026-10-07 → 07/10 */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-')
  return `${d}/${m}`
}
