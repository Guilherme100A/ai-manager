// Relatório diário por chip: estado agora + números por dia (Brasília) para decidir ajustes.
import { useState } from 'react'
import { ErrorText, PageHeader, StateIndicator } from '../components/ui'
import { formatDateTime } from '../lib/aggregate'
import { api } from '../lib/api'
import { usePoll } from '../lib/hooks'
import type { ReportDayRow } from '../lib/types'
import { formatCodes, rowFlags, shortDay, totalsBySession } from './Report.logic'

const REFRESH_MS = 60_000
const PERIODS = [1, 3, 7, 14, 30] as const

export function Report() {
  const [days, setDays] = useState<number>(7)
  const { data, error } = usePoll(() => api.dailyReport(days), REFRESH_MS, [days])
  const names = new Map((data?.chips ?? []).map((c) => [c.sessionId, c.name]))
  const totals = totalsBySession(data?.rows ?? [])

  return (
    <div data-testid="page-report">
      <PageHeader
        title="Relatório"
        subtitle={data ? `Atualiza a cada minuto · gerado em ${formatDateTime(data.generatedAt)} · dias no horário de Brasília` : 'Carregando…'}
      >
        <label className="muted" htmlFor="report-days">Período</label>{' '}
        <select id="report-days" data-testid="report-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {PERIODS.map((p) => (
            <option key={p} value={p}>{p === 1 ? 'hoje' : `${p} dias`}</option>
          ))}
        </select>
      </PageHeader>
      <ErrorText error={error} />

      <section className="panel">
        <h2>Agora</h2>
        <div className="table-wrap">
          <table data-testid="report-now">
            <thead>
              <tr>
                <th>Chip</th>
                <th>Estado</th>
                <th>Score</th>
                <th>Proxy</th>
                <th>Aquecimento</th>
                <th>Limite do dia</th>
                <th>No período: enviadas / falhas / recebidas</th>
                <th>Quedas</th>
                <th>Bloqueios</th>
                <th>Grupos (entrou)</th>
              </tr>
            </thead>
            <tbody>
              {(data?.chips ?? []).map((c) => {
                const t = totals.get(c.sessionId)
                return (
                  <tr key={c.sessionId} data-testid="report-chip">
                    <td className="cell-strong">
                      {c.name}
                      <div className="muted mono">{c.phone ?? '—'}</div>
                    </td>
                    <td><StateIndicator state={c.status} testId="report-state" /></td>
                    <td className={c.score < 70 ? 'report-warn' : undefined}>{c.score} <span className="muted">{c.label}</span></td>
                    <td>{c.proxy ? 'sim' : 'não (IP da VPS)'}</td>
                    <td>dia {c.warmupDay + 1} · {c.warmupPercent}%</td>
                    <td>{c.dailyLimit ?? 'sem limite'}</td>
                    <td>{t ? `${t.sent} / ${t.failed} / ${t.received}` : '0 / 0 / 0'}</td>
                    <td>{t?.disconnects ?? 0}</td>
                    <td className={t?.blocked ? 'report-alert' : undefined}>{t?.blocked ?? 0}</td>
                    <td>{t?.groupsJoined ?? 0}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Por dia</h2>
        <p className="muted">
          Quedas por código: 428/503 são o WhatsApp fechando a conexão (rotina), 408 é tempo esgotado (rede ou proxy), 401/403 é bloqueio.
          Grupos: entrou · pendente (aguardando admin) · descartado · descoberto para repassar.
        </p>
        <div className="table-wrap">
          <table data-testid="report-days-table">
            <thead>
              <tr>
                <th>Dia</th>
                <th>Chip</th>
                <th>Enviadas</th>
                <th>Falhas</th>
                <th>Recebidas</th>
                <th>Quedas</th>
                <th>Códigos</th>
                <th>Quedas c/ travamento</th>
                <th>Proxy caiu</th>
                <th>DEGRADED</th>
                <th>Bloqueios</th>
                <th>Grupos</th>
                <th>Atenção</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((r) => (
                <DayRow key={`${r.day}-${r.sessionId}`} row={r} name={names.get(r.sessionId) ?? r.sessionId} />
              ))}
            </tbody>
          </table>
          {data && data.rows.length === 0 ? <p className="empty">Sem atividade no período.</p> : null}
        </div>
      </section>

      <section className="panel" data-testid="report-worker">
        <h2>Worker</h2>
        <p className="muted">
          Travamento = o processo ficou mais de 1 s sem responder. Nesse tempo as conexões não respondem o WhatsApp, que pode
          derrubar vários chips juntos. Se as quedas aparecem logo após travamentos, a causa é nossa; se não, é do WhatsApp ou da rede.
        </p>
        {data && data.worker.length === 0 ? (
          <p className="empty">Nenhum travamento no período.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dia</th>
                  <th>Travamentos</th>
                  <th>Maior</th>
                </tr>
              </thead>
              <tbody>
                {(data?.worker ?? []).map((w) => (
                  <tr key={w.day} data-testid="report-worker-day">
                    <td>{shortDay(w.day)}</td>
                    <td className="report-warn">{w.stalls}</td>
                    <td>{(w.maxLagMs / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.recentStalls.length > 0 ? (
          <>
            <h3>Últimos travamentos</h3>
            <ul className="muted">
              {data.recentStalls.map((s) => (
                <li key={s.at}>
                  {formatDateTime(s.at)} · {(s.lagMs / 1000).toFixed(1)} s{s.heapMb !== null ? ` · memória ${s.heapMb} MB` : ''}
                  {Object.keys(s.activity).length
                    ? ` · antes: ${Object.entries(s.activity).slice(0, 4).map(([label, n]) => `${label}×${n}`).join(', ')}`
                    : ' · antes: nada registrado'}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  )
}

function DayRow({ row, name }: { row: ReportDayRow; name: string }) {
  const flags = rowFlags(row)
  return (
    <tr data-testid="report-day-row">
      <td className="nowrap">{shortDay(row.day)}</td>
      <td className="cell-strong">{name}</td>
      <td>{row.sent}</td>
      <td className={row.failed ? 'report-alert' : undefined}>{row.failed}</td>
      <td>{row.received}</td>
      <td className={row.disconnects >= 3 ? 'report-warn' : undefined}>{row.disconnects}</td>
      <td className="mono">{formatCodes(row.disconnectCodes)}</td>
      <td className={row.disconnectsNearStall ? 'report-warn' : undefined}>{row.disconnectsNearStall || '—'}</td>
      <td>{row.proxyUnavailable || '—'}</td>
      <td>{row.degraded || '—'}</td>
      <td className={row.blocked ? 'report-alert' : undefined}>{row.blocked}</td>
      <td className="nowrap">{row.groupsJoined} · {row.groupsPending} · {row.groupsRejected} · {row.groupsDiscovered}</td>
      <td>
        {flags.length
          ? flags.map((f) => (
            <div key={f.text} className={f.level === 'alert' ? 'report-alert' : 'report-warn'}>{f.text}</div>
          ))
          : <span className="muted">ok</span>}
      </td>
    </tr>
  )
}

