import { useState, type FormEvent } from 'react'
import { ErrorText, PageHeader } from '../components/ui'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'

export function SessionLinks() {
  const sessions = usePoll(() => api.sessions(), POLL.page)
  const links = usePoll(() => api.sessionLinks(), POLL.page)
  const runs = usePoll(() => api.sessionRouteRuns(), POLL.page)
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [matchText, setMatchText] = useState('')
  const [replyText, setReplyText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const name = (id: string) => sessions.data?.find((s) => s.id === id)?.name ?? id

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try { await action(); links.reload(); runs.reload() }
    catch (err) { setError(err) }
    finally { setBusy(false) }
  }
  async function create(event: FormEvent) {
    event.preventDefault()
    await mutate(async () => {
      await api.createSessionLink({ sourceSessionId: source, targetSessionId: target, rules: { matchText, replyText } })
      setMatchText(''); setReplyText('')
    })
  }

  return <div data-testid="page-session-links">
    <PageHeader title="Vínculos de sessões" subtitle="Quando A recebe uma mensagem que corresponde à regra, B envia a resposta configurada." />
    <form className="panel stack" onSubmit={create}>
      <h2>Novo vínculo</h2>
      <label>Sessão que recebe (A)
        <select required value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Selecione</option>
          {sessions.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>Sessão que envia a resposta (B)
        <select required value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Selecione</option>
          {sessions.data?.filter((s) => s.id !== source).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>Mensagem recebida (texto exato, sem diferenciar maiúsculas)
        <input required maxLength={4096} value={matchText} onChange={(e) => setMatchText(e.target.value)} placeholder="oi" />
      </label>
      <label>Resposta enviada por B
        <textarea required maxLength={4096} value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Olá!" />
      </label>
      <p className="muted">B responde ao contato que escreveu para A. O vínculo é criado desativado. Ao ativá-lo, a resposta será automática. O contato precisa ter consentimento registrado em Contatos. Mensagens de contas gerenciadas não disparam novas respostas, evitando ciclos.</p>
      <button disabled={busy || !source || !target || source === target}>Criar vínculo desativado</button>
    </form>
    <ErrorText error={error ?? links.error ?? sessions.error ?? runs.error} />
    <div className="table-wrap"><table>
      <thead><tr><th>Fluxo</th><th>Regra</th><th>Destinatário</th><th>Estado</th><th>Ações</th></tr></thead>
      <tbody>{links.data?.map((link) => <tr key={link.id}>
        <td>{name(link.sourceSessionId)} → {name(link.targetSessionId)}</td>
        <td>{link.rules.matchText} → {link.rules.replyText}</td>
        <td>Contato remetente</td>
        <td>{link.enabled ? 'Ativado' : 'Desativado'}</td>
        <td><button className="secondary" disabled={busy} onClick={() => mutate(() => api.enableSessionLink(link.id, !link.enabled))}>{link.enabled ? 'Desativar' : 'Ativar envio automático'}</button>{' '}
          <button className="secondary" disabled={busy || link.enabled} onClick={() => mutate(() => api.deleteSessionLink(link.id))}>Excluir</button></td>
      </tr>)}
      {links.data?.length === 0 && <tr><td colSpan={5}>Nenhum vínculo cadastrado.</td></tr>}
      </tbody>
    </table></div>
    <section className="panel stack">
      <h2>Últimas execuções</h2>
      <p className="muted">Enfileirada significa que a mensagem aguarda envio. Desativar um vínculo impede novos disparos; mensagens já enfileiradas permanecem na fila.</p>
      <ul>{runs.data?.map((run) => {
        const link = links.data?.find((item) => item.id === run.linkId)
        return <li key={`${run.linkId}:${run.inboundId}`}>
          {link ? `${name(link.sourceSessionId)} → ${name(link.targetSessionId)}` : run.linkId}: {' '}
          {run.status === 'queued' ? 'Enfileirada' : run.status === 'failed' ? `Falhou (${run.error})` : 'Em processamento ou interrompida'}
        </li>
      })}</ul>
      {runs.data?.length === 0 && <p>Nenhuma execução.</p>}
    </section>
  </div>
}
