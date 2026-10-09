import { useState } from 'react'
import { ProxySharingBar } from '../components/ProxySharingBar'
import { ErrorText, PageHeader, StateIndicator } from '../components/ui'
import { formatDateTime } from '../lib/aggregate'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import { proxyAddress } from '../lib/proxy-form'
import { routeHref } from '../lib/router'
import type { SessionMessageCounts } from '../lib/types'

export function Sessions() {
  const { data, error, reload } = usePoll(() => api.sessions(), POLL.list)
  const counts = usePoll(() => api.messageCounts(), POLL.page)
  const [removing, setRemoving] = useState<string>()
  const [actionError, setActionError] = useState<unknown>()

  async function remove(id: string, label: string) {
    if (!window.confirm(`Excluir ${label}? O aparelho será desvinculado e o histórico de mensagens, a fila e as automações desta sessão serão apagados. Não dá para desfazer.`)) return
    setRemoving(id)
    setActionError(undefined)
    try {
      await api.deleteSession(id)
      reload()
    } catch (err) {
      setActionError(err)
    } finally {
      setRemoving(undefined)
    }
  }

  return (
    <div data-testid="page-sessions">
      <PageHeader title="Sessões" subtitle="Números conectados, estado e proxy de cada sessão.">
        <a className="button" href={routeHref({ name: 'new-session' })} data-testid="add-session">
          + Adicionar número
        </a>
      </PageHeader>
      <ErrorText error={error} />
      <ErrorText error={actionError} testId="action-error" />
      <ProxySharingBar />
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Estado</th>
            <th>Nome</th>
            <th>Número</th>
            <th>Proxy</th>
            <th title="Mensagens que saíram para o WhatsApp">Enviadas</th>
            <th>Recebidas</th>
            <th>Última conexão</th>
            <th>Observação</th>
            <th aria-label="Ações" />
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((s) => (
            <tr key={s.id} data-testid="session-row" data-session-id={s.id} data-state={s.status}>
              <td>
                <StateIndicator state={s.status} />
              </td>
              <td className="cell-strong">
                <a href={routeHref({ name: 'session', id: s.id })} data-testid="session-link">
                  {s.name}
                </a>
              </td>
              <td className="mono">{s.phone ?? '—'}</td>
              <td className={s.proxy ? 'mono' : 'muted'} data-testid="session-proxy">{proxyAddress(s.proxy)}</td>
              <MessageCountCell counts={counts.data?.[s.id]} kind="sent" />
              <MessageCountCell counts={counts.data?.[s.id]} kind="received" />
              <td className="muted">{formatDateTime(s.lastConnectedAt)}</td>
              <td className="muted">{s.note ?? ''}</td>
              <td className="cell-delete">
                <button type="button" className="danger btn-sm" data-testid="session-delete" disabled={removing !== undefined} onClick={() => void remove(s.id, `${s.name} (${s.phone ?? 'sem número'})`)}>
                  {removing === s.id ? 'Excluindo…' : 'Excluir'}
                </button>
              </td>
            </tr>
          ))}
          {data && data.length === 0 ? (
            <tr>
              <td colSpan={9} className="empty">
                Nenhuma sessão
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      </div>
    </div>
  )
}

/** Total desde o início e, embaixo, as últimas 24 horas. */
function MessageCountCell({ counts, kind }: { counts: SessionMessageCounts | undefined; kind: 'sent' | 'received' }) {
  if (!counts) return <td className="muted" data-testid={`session-${kind}`}>0</td>
  const total = kind === 'sent' ? counts.sentTotal : counts.receivedTotal
  const day = kind === 'sent' ? counts.sent24h : counts.received24h
  return (
    <td className="nowrap" data-testid={`session-${kind}`}>
      <span className="cell-strong">{total.toLocaleString('pt-BR')}</span>
      <div className="muted">{day} em 24 h</div>
    </td>
  )
}
