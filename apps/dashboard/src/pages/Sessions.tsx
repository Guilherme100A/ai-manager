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
  const operating = data?.filter((s) => s.status === 'WARMING' || s.status === 'STABLE').length ?? 0
  const needAttention = data?.filter((s) => s.status === 'NEW' || s.status === 'DISCONNECTED' || s.status === 'DEGRADED' || s.status === 'PAUSED').length ?? 0

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
    <div className="chip-workspace" data-testid="page-sessions">
      <nav className="chip-breadcrumb" aria-label="Caminho"><a href={routeHref({ name: 'home' })}>Painel</a><span aria-hidden="true">/</span><span>Chips</span></nav>
      <PageHeader title="Chips" subtitle="Acompanhe conexão, mensagens e proxy de cada número.">
        <a className="button" href={routeHref({ name: 'new-session' })} data-testid="add-session">
          + Adicionar número
        </a>
      </PageHeader>
      <ErrorText error={error} />
      <ErrorText error={actionError} testId="action-error" />
      <div className="chip-overview" aria-label="Resumo dos chips" data-testid="chips-overview">
        <div className="chip-overview-card"><span>Total de chips</span><strong data-testid="chips-total">{data?.length ?? '…'}</strong></div>
        <div className="chip-overview-card"><span>Em operação</span><strong data-testid="chips-connected">{data ? operating : '…'}</strong></div>
        <div className="chip-overview-card"><span>Precisam de atenção</span><strong data-testid="chips-attention">{data ? needAttention : '…'}</strong></div>
      </div>
      <ProxySharingBar />
      <div className="chip-list-head"><h2>Seus chips</h2><p>{data ? `${data.length} número${data.length === 1 ? '' : 's'} cadastrado${data.length === 1 ? '' : 's'}` : 'Carregando chips…'}</p></div>
      <div className="chip-cards" data-testid="chip-list">
        {(data ?? []).map((s) => (
          <article className="chip-card" key={s.id} data-testid="session-row" data-session-id={s.id} data-state={s.status}>
            <div className="chip-card-head">
              <div className="chip-card-identity">
                <StateIndicator state={s.status} />
                <a href={routeHref({ name: 'session', id: s.id })} data-testid="session-link">{s.name}</a>
                <span className="mono muted">{s.phone ?? 'Sem número'}</span>
              </div>
              <button type="button" className="danger btn-sm" data-testid="session-delete" disabled={removing !== undefined} onClick={() => void remove(s.id, `${s.name} (${s.phone ?? 'sem número'})`)}>
                {removing === s.id ? 'Excluindo…' : 'Excluir'}
              </button>
            </div>
            <dl className="chip-card-details">
              <div><dt>Proxy</dt><dd className={s.proxy ? 'mono' : 'muted'} data-testid="session-proxy">{proxyAddress(s.proxy)}</dd></div>
              <div><dt>Enviadas</dt><dd><MessageCountValue counts={counts.data?.[s.id]} kind="sent" /></dd></div>
              <div><dt>Recebidas</dt><dd><MessageCountValue counts={counts.data?.[s.id]} kind="received" /></dd></div>
              <div><dt>Última conexão</dt><dd>{formatDateTime(s.lastConnectedAt)}</dd></div>
              {s.note && <div className="chip-card-note"><dt>Observação</dt><dd>{s.note}</dd></div>}
            </dl>
          </article>
        ))}
        {data && data.length === 0 ? <p className="empty">Nenhum chip cadastrado.</p> : null}
      </div>
    </div>
  )
}

/** Total desde o início e, embaixo, as últimas 24 horas. */
function MessageCountValue({ counts, kind }: { counts: SessionMessageCounts | undefined; kind: 'sent' | 'received' }) {
  if (!counts) return <span className="muted" data-testid={`session-${kind}`}>0</span>
  const total = kind === 'sent' ? counts.sentTotal : counts.receivedTotal
  const day = kind === 'sent' ? counts.sent24h : counts.received24h
  return (
    <span className="chip-count" data-testid={`session-${kind}`}>
      <span className="cell-strong">{total.toLocaleString('pt-BR')}</span>
      <div className="muted" title={kind === 'sent' ? 'Janela móvel pelo horário em que a mensagem saiu pelo WhatsApp' : 'Janela móvel pelo horário em que a mensagem chegou'}>{day} nas últimas 24 h</div>
    </span>
  )
}
