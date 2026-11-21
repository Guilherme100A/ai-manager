import { useRef, useState, type FormEvent } from 'react'
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
  const pending = useRef(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState<unknown>()
  const name = (id: string) => sessions.data?.find((s) => s.id === id)?.name ?? id

  async function mutate(action: () => Promise<unknown>, success: string) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setNotice('')
    setError(undefined)
    try { await action(); setNotice(success); links.reload(); runs.reload() }
    catch (err) { setError(err) }
    finally { pending.current = false; setBusy(false) }
  }
  async function create(event: FormEvent) {
    event.preventDefault()
    if (!source || !target || source === target || pending.current) return
    await mutate(async () => {
      await api.createSessionLink({ sourceSessionId: source, targetSessionId: target, rules: { matchText, replyText } })
      setMatchText(''); setReplyText('')
    }, 'Vínculo criado desativado.')
  }

  return <div className="chip-workspace" data-testid="page-session-links">
    <PageHeader title="Vínculos de sessões" subtitle="Quando A recebe uma mensagem que corresponde à regra, B envia a resposta configurada." />
    <form className="panel links-form" onSubmit={create} aria-busy={busy}>
      <h2>Novo vínculo</h2>
      <label>Sessão que recebe (A)
        <select required disabled={busy || sessions.loading} value={source} onChange={(e) => {
          setSource(e.target.value)
          if (target === e.target.value) setTarget('')
        }}>
          <option value="">Selecione</option>
          {sessions.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>Sessão que envia a resposta (B)
        <select required disabled={busy || sessions.loading} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Selecione</option>
          {sessions.data?.filter((s) => s.id !== source).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label className="links-wide">Mensagem recebida (texto exato, sem diferenciar maiúsculas)
        <input required disabled={busy} maxLength={4096} value={matchText} onChange={(e) => setMatchText(e.target.value)} placeholder="oi" />
      </label>
      <label className="links-wide">Resposta enviada por B
        <textarea required disabled={busy} maxLength={4096} value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Olá!" />
      </label>
      <p className="hint">B responde ao contato que escreveu para A. O vínculo é criado desativado. Ao ativá-lo, a resposta será automática. O contato precisa ter consentimento registrado em Contatos. Mensagens de contas gerenciadas não disparam novas respostas, evitando ciclos.</p>
      {sessions.loading ? <p className="hint" role="status">Carregando sessões…</p> : sessions.data && sessions.data.length < 2 ? <p className="hint" role="status">Cadastre pelo menos dois chips diferentes para criar um vínculo.</p> : null}
      <div className="actions"><button disabled={busy || !source || !target || source === target}>Criar vínculo desativado</button></div>
    </form>
    <ErrorText error={error ?? links.error ?? sessions.error ?? runs.error} />
    {busy || notice ? <p role="status" className="operation-status">{busy ? 'Processando vínculo…' : notice}</p> : null}
    <div className="chip-list-head"><h2>Vínculos cadastrados</h2><p>Ative somente após conferir as contas e a regra.</p></div>
    {links.loading ? <p role="status">Carregando vínculos…</p> : null}
    <div className="table-wrap"><table className="links-table" aria-label="Vínculos cadastrados">
      <thead><tr><th>Fluxo</th><th>Regra</th><th>Destinatário</th><th>Estado</th><th>Ações</th></tr></thead>
      <tbody>{links.data?.map((link) => <tr key={link.id}>
        <td data-label="Fluxo">{name(link.sourceSessionId)} → {name(link.targetSessionId)}</td>
        <td data-label="Regra">{link.rules.matchText} → {link.rules.replyText}</td>
        <td data-label="Destinatário">Contato remetente</td>
        <td data-label="Estado">{link.enabled ? 'Ativado' : 'Desativado'}</td>
        <td data-label="Ações"><div className="actions"><button type="button" className="secondary" disabled={busy} onClick={() => mutate(() => api.enableSessionLink(link.id, !link.enabled), link.enabled ? 'Vínculo desativado.' : 'Envio automático ativado.')}>{link.enabled ? 'Desativar' : 'Ativar envio automático'}</button>
          <button type="button" className="danger" disabled={busy || link.enabled} onClick={() => mutate(() => api.deleteSessionLink(link.id), 'Vínculo excluído.')}>Excluir</button></div>
          {link.enabled ? <p className="hint">Desative antes de excluir.</p> : null}</td>
      </tr>)}
      {links.data?.length === 0 && <tr><td colSpan={5}>Nenhum vínculo cadastrado.</td></tr>}
      </tbody>
    </table></div>
    <section className="panel stack">
      <h2>Últimas execuções</h2>
      <p className="muted">Enfileirada significa que a mensagem aguarda envio. Desativar um vínculo impede novos disparos; mensagens já enfileiradas permanecem na fila.</p>
      {runs.loading ? <p role="status">Carregando execuções…</p> : null}
      <ul className="links-runs">{runs.data?.map((run) => {
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
