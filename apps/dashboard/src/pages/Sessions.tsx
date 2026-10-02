import { ErrorText, PageHeader, StateIndicator } from '../components/ui'
import { formatDateTime } from '../lib/aggregate'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import { proxyAddress } from '../lib/proxy-form'
import { routeHref } from '../lib/router'

export function Sessions() {
  const { data, error } = usePoll(() => api.sessions(), POLL.list)
  return (
    <div data-testid="page-sessions">
      <PageHeader title="Sessões" subtitle="Números conectados, estado e proxy de cada sessão.">
        <a className="button" href={routeHref({ name: 'new-session' })} data-testid="add-session">
          + Adicionar número
        </a>
      </PageHeader>
      <ErrorText error={error} />
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Estado</th>
            <th>Nome</th>
            <th>Número</th>
            <th>Proxy</th>
            <th>Última conexão</th>
            <th>Observação</th>
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
              <td className="muted">{formatDateTime(s.lastConnectedAt)}</td>
              <td className="muted">{s.note ?? ''}</td>
            </tr>
          ))}
          {data && data.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty">
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
