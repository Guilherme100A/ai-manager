import { describe, expect, it } from 'vitest'
import type { ReportDayRow } from '../lib/types'
import { formatCodes, rowFlags, shortDay, totalsBySession } from './Report.logic'

const row = (over: Partial<ReportDayRow> = {}): ReportDayRow => ({
  day: '2026-10-07', sessionId: 's1', sent: 0, failed: 0, received: 0, disconnects: 0, disconnectCodes: {}, proxyUnavailable: 0,
  degraded: 0, recovered: 0, blocked: 0, groupsJoined: 0, groupsPending: 0, groupsRejected: 0, groupsDiscovered: 0, disconnectsNearStall: 0, ...over,
})

describe('relatório: o que merece atenção', () => {
  it('dia tranquilo não gera alerta; 1 ou 2 quedas são rotina', () => {
    expect(rowFlags(row({ sent: 20, disconnects: 2 }))).toEqual([])
  })
  it('bloqueio e falha são alerta; muitas quedas, proxy e DEGRADED são aviso', () => {
    const flags = rowFlags(row({ blocked: 1, failed: 2, disconnects: 3, proxyUnavailable: 1, degraded: 1 }))
    expect(flags.map((f) => f.level)).toEqual(['alert', 'alert', 'warn', 'warn', 'warn'])
    expect(flags[0]!.text).toContain('bloqueio')
  })
  it('queda logo após travamento do worker vira aviso', () => {
    expect(rowFlags(row({ disconnects: 1, disconnectsNearStall: 1 }))).toEqual([{ level: 'warn', text: '1 queda(s) logo após travamento do worker' }])
  })
  it('códigos de queda: maior primeiro', () => {
    expect(formatCodes({ 503: 1, 428: 3, 408: 1 })).toBe('428×3 · 408×1 · 503×1')
    expect(formatCodes({})).toBe('—')
  })
  it('totais por chip somam os dias', () => {
    const t = totalsBySession([row({ sent: 5, disconnects: 1 }), row({ day: '2026-10-06', sent: 3, blocked: 1 }), row({ sessionId: 's2', sent: 9 })])
    expect(t.get('s1')).toMatchObject({ sent: 8, disconnects: 1, blocked: 1 })
    expect(t.get('s2')).toMatchObject({ sent: 9 })
  })
  it('dia curto', () => expect(shortDay('2026-10-07')).toBe('07/10'))
})
