// Relatório diário por chip: números para decidir ajustes (quedas, bloqueios, envios, grupos). Só leitura.
import { sql } from 'drizzle-orm'
import type { Database } from '@wsm/db'
import { HealthService, type HealthServiceOptions } from '../health/service'
import type { SessionState } from '../session/states'

/** Dias no fuso de Brasília: o "dia" do relatório é o mesmo que o operador vê no relógio. */
export const REPORT_TIME_ZONE = 'America/Sao_Paulo'
export const MAX_REPORT_DAYS = 31

export interface ReportChipNow {
  sessionId: string
  name: string
  phone: string | null
  status: SessionState
  proxy: boolean
  score: number
  label: string
  warmupDay: number
  warmupPercent: number
  /** Limite de envios do dia de aquecimento; null quando o aquecimento terminou. */
  dailyLimit: number | null
  lastConnectedAt: string | null
}

export interface ReportDayRow {
  /** AAAA-MM-DD (Brasília). */
  day: string
  sessionId: string
  sent: number
  failed: number
  received: number
  disconnects: number
  /** Quedas por código do WhatsApp (ex.: {"428": 3, "503": 1}); "?" quando sem código. */
  disconnectCodes: Record<string, number>
  proxyUnavailable: number
  degraded: number
  recovered: number
  /** 401 (deslogado) + 403 (proibido): sinal de bloqueio. */
  blocked: number
  groupsJoined: number
  groupsPending: number
  groupsRejected: number
  groupsDiscovered: number
}

export interface DailyReport {
  generatedAt: string
  days: string[]
  chips: ReportChipNow[]
  rows: ReportDayRow[]
}

export interface DailyReportOptions {
  days?: number
  now?: () => Date
  health?: HealthServiceOptions
}

const num = (v: unknown) => Number(v ?? 0)
const dayOf = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: REPORT_TIME_ZONE })

export async function buildDailyReport(db: Database, opts: DailyReportOptions = {}): Promise<DailyReport> {
  const now = (opts.now ?? (() => new Date()))()
  const days = Math.min(MAX_REPORT_DAYS, Math.max(1, Math.floor(opts.days ?? 7)))
  const dayList = Array.from({ length: days }, (_, i) => dayOf(new Date(now.getTime() - i * 86_400_000)))
  const since = new Date(now.getTime() - (days + 1) * 86_400_000)
  const day = (col: string) => sql.raw(`to_char(${col} at time zone '${REPORT_TIME_ZONE}', 'YYYY-MM-DD')`)

  const sessionRows = (await db.execute(sql`
    select id, name, phone, status, proxy_id, warmup_started_at, last_connected_at from sessions order by created_at`)).rows as Array<Record<string, unknown>>

  const msgRows = (await db.execute(sql`
    select ${day('created_at')} as day, session_id,
      count(*) filter (where direction = 'outbound' and status in ('sent', 'delivered', 'read')) as sent,
      count(*) filter (where status = 'failed') as failed,
      count(*) filter (where direction = 'inbound') as received
    from messages where created_at > ${since} group by 1, 2`)).rows as Array<Record<string, unknown>>

  const evRows = (await db.execute(sql`
    select ${day('created_at')} as day, session_id, type,
      case when type = 'disconnected' then coalesce(detail->>'statusCode', '?') end as code,
      coalesce(detail->>'reason', '') as reason, count(*) as n
    from health_events where created_at > ${since}
      and type in ('disconnected', 'proxy_unavailable', 'health_degraded', 'health_recovered', 'forbidden_403')
    group by 1, 2, 3, 4, 5`)).rows as Array<Record<string, unknown>>

  const groupRows = (await db.execute(sql`
    select ${day('created_at')} as day,
      case when action = 'group.invite.flow' then detail->>'targetSessionId' else target_id end as session_id,
      case
        when detail->>'action' = 'join_result' and detail->>'state' = 'joined' then 'joined'
        when detail->>'action' = 'join_result' then 'pending'
        when action = 'group.invite.flow' and detail->>'result' = 'joined' then 'joined'
        when action = 'group.invite.flow' and detail->>'result' = 'awaiting_confirmation' then 'pending'
        when detail->>'action' = 'group_rejected' then 'rejected'
        when detail->>'action' = 'group_discovered' then 'discovered'
      end as kind, count(*) as n
    from audit_logs where actor = 'group-automation' and created_at > ${since} group by 1, 2, 3`)).rows as Array<Record<string, unknown>>

  const rows = new Map<string, ReportDayRow>()
  const row = (d: string, sessionId: string) => {
    const key = `${d}|${sessionId}`
    let r = rows.get(key)
    if (!r) {
      r = { day: d, sessionId, sent: 0, failed: 0, received: 0, disconnects: 0, disconnectCodes: {}, proxyUnavailable: 0, degraded: 0,
        recovered: 0, blocked: 0, groupsJoined: 0, groupsPending: 0, groupsRejected: 0, groupsDiscovered: 0 }
      rows.set(key, r)
    }
    return r
  }
  const known = new Set(sessionRows.map((s) => String(s.id)))
  const keep = (d: unknown, id: unknown) => dayList.includes(String(d)) && known.has(String(id))

  for (const m of msgRows) {
    if (!keep(m.day, m.session_id)) continue
    const r = row(String(m.day), String(m.session_id))
    r.sent += num(m.sent)
    r.failed += num(m.failed)
    r.received += num(m.received)
  }
  for (const e of evRows) {
    if (!keep(e.day, e.session_id)) continue
    const r = row(String(e.day), String(e.session_id))
    const n = num(e.n)
    if (e.type === 'disconnected') {
      r.disconnects += n
      const code = String(e.code)
      r.disconnectCodes[code] = (r.disconnectCodes[code] ?? 0) + n
      if (e.reason === 'loggedOut' || code === '401') r.blocked += n
    } else if (e.type === 'proxy_unavailable') r.proxyUnavailable += n
    else if (e.type === 'health_degraded') r.degraded += n
    else if (e.type === 'health_recovered') r.recovered += n
    else if (e.type === 'forbidden_403') r.blocked += n
  }
  for (const g of groupRows) {
    if (!g.kind || !keep(g.day, g.session_id)) continue
    const r = row(String(g.day), String(g.session_id))
    const n = num(g.n)
    if (g.kind === 'joined') r.groupsJoined += n
    else if (g.kind === 'pending') r.groupsPending += n
    else if (g.kind === 'rejected') r.groupsRejected += n
    else if (g.kind === 'discovered') r.groupsDiscovered += n
  }

  const health = new HealthService(db, { ...opts.health, now: () => now })
  const chips: ReportChipNow[] = []
  for (const s of sessionRows) {
    const ev = await health.evaluate(String(s.id))
    chips.push({
      sessionId: String(s.id),
      name: String(s.name),
      phone: s.phone ? String(s.phone) : null,
      status: ev.row.status,
      proxy: s.proxy_id != null,
      score: ev.score,
      label: ev.label,
      warmupDay: ev.warmup.day,
      warmupPercent: ev.warmup.percent,
      dailyLimit: ev.warmup.dailyLimit,
      lastConnectedAt: ev.row.lastConnectedAt ? new Date(ev.row.lastConnectedAt).toISOString() : null,
    })
  }

  const order = new Map(chips.map((c, i) => [c.sessionId, i]))
  return {
    generatedAt: now.toISOString(),
    days: dayList,
    chips,
    rows: [...rows.values()].sort((a, b) => b.day.localeCompare(a.day) || (order.get(a.sessionId)! - order.get(b.sessionId)!)),
  }
}
