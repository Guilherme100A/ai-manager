// Grupos: leitura, adição manual e fluxo explícito de convite entre duas sessões.
// T20: em grupos em que a sessão é admin, "Adicionar número" adiciona UMA sessão do sistema, com confirmação.
import { useState } from 'react'
import { GroupAddDialog } from '../components/GroupAddDialog'
import { GroupAutomationPanel } from '../components/GroupAutomationPanel'
import { ErrorText, PageHeader } from '../components/ui'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import { indicatorText } from '../lib/states'
import { request } from '../lib/api'
import { NOT_ADMIN_HINT, targetOptions, sessionLabel, type GroupWithAdmin } from './Groups.logic'

export function Groups() {
  const sessions = usePoll(() => api.sessions(), POLL.page)
  const [sessionId, setSessionId] = useState('')
  const [groups, setGroups] = useState<GroupWithAdmin[]>()
  const [adding, setAdding] = useState<GroupWithAdmin>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [targetId, setTargetId] = useState('')
  const [pool, setPool] = useState<string[]>([])
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState<string>()

  async function invite() {
    setInviting(true)
    setError(undefined)
    setInviteResult(undefined)
    try {
      const out = await request<{ groupId: string; result: 'joined' | 'awaiting_confirmation' }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/groups/invite-flow`,
        { method: 'POST', body: { targetSessionId: targetId, groupIds: pool } },
      )
      const group = groups?.find((g) => g.id === out.groupId)
      setInviteResult(out.result === 'joined'
        ? `B recebeu o convite de A e entrou em ${group?.name || out.groupId}.`
        : `B recebeu e aceitou o convite de ${group?.name || out.groupId}. A entrada ainda aguarda confirmação do WhatsApp ou aprovação do admin.`)
    } catch (err) {
      setError(err)
    } finally {
      setInviting(false)
    }
  }

  async function load(id: string, refresh = false) {
    setSessionId(id)
    setGroups(undefined)
    setAdding(undefined)
    setPool([])
    setTargetId('')
    setInviteResult(undefined)
    setError(undefined)
    if (!id) return
    setBusy(true)
    try {
      setGroups(refresh ? await api.refreshGroups(id) : await api.groups(id))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="page-groups">
      <PageHeader title="Grupos" subtitle="Veja os grupos ou envie um convite de uma sessão para outra." />
      <div className="panel inline-form toolbar">
        <label htmlFor="groups-session">Sessão</label>
        <select id="groups-session" data-testid="groups-session" value={sessionId} disabled={inviting} onChange={(e) => load(e.target.value)}>
          <option value="">Selecione…</option>
          {(sessions.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.phone}) — {indicatorText(s.status)}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" data-testid="groups-refresh" disabled={!sessionId || busy || inviting} onClick={() => load(sessionId, true)}>
          Atualizar
        </button>
      </div>
      <ErrorText error={error} testId="groups-error" />
      {sessionId ? <GroupAutomationPanel key={sessionId} sessionId={sessionId} sessions={sessions.data ?? []} /> : null}
      {groups && sessionId ? (
        <div className="panel">
          <h2>Convite entre sessões</h2>
          <p className="hint">A é a sessão selecionada acima. Marque os grupos abaixo: um deles será sorteado, A enviará o link e B entrará após recebê-lo. A precisa ser admin e B ainda não pode ser membro. O número de B precisa estar autorizado em Contatos para receber mensagens.</p>
          <label htmlFor="invite-target">Sessão B</label>
          <select id="invite-target" value={targetId} disabled={inviting} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Selecione…</option>
            {targetOptions(sessions.data ?? [], sessionId).filter((s) => s.status === 'STABLE' || s.status === 'WARMING').map((s) => (
              <option key={s.id} value={s.id}>{sessionLabel(s)}</option>
            ))}
          </select>
          <button type="button" disabled={inviting || busy || !targetId || !pool.length} onClick={() => void invite()}>
            {inviting ? 'Enviando convite e aguardando B…' : 'Enviar convite e entrar'}
          </button>
          {inviteResult ? <p role="status">{inviteResult}</p> : null}
        </div>
      ) : null}
      {groups ? (
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Sortear</th>
              <th>Participantes</th>
              <th>Envio</th>
              <th>Comunidade</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id} data-testid="group-row" data-group-id={g.id}>
                <td className="cell-strong">{g.name}</td>
                <td>
                  <input type="checkbox" aria-label={`Incluir ${g.name || g.id} no sorteio`} checked={pool.includes(g.id)}
                    disabled={!g.isAdmin || inviting} onChange={(e) => setPool((ids) => e.target.checked ? [...ids, g.id] : ids.filter((id) => id !== g.id))} />
                </td>
                <td>{g.participants}</td>
                <td>
                  <span className="tag">{g.announce ? 'Somente admins' : 'Aberto'}</span>
                </td>
                <td className="mono muted">{g.communityId ?? '—'}</td>
                <td className="cell-actions">
                  <button
                    type="button"
                    className="secondary btn-sm"
                    data-testid="group-add-number"
                    disabled={!g.isAdmin || inviting}
                    title={g.isAdmin ? 'Adicionar uma sessão do sistema a este grupo' : NOT_ADMIN_HINT}
                    onClick={() => setAdding(g)}
                  >
                    Adicionar número
                  </button>
                  {!g.isAdmin ? (
                    <small className="hint" data-testid="group-add-hint">
                      {NOT_ADMIN_HINT}
                    </small>
                  ) : null}
                </td>
              </tr>
            ))}
            {groups.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  Nenhum grupo
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        </div>
      ) : null}
      {adding && sessionId ? (
        <GroupAddDialog
          key={adding.id}
          adminSessionId={sessionId}
          group={adding}
          sessions={sessions.data ?? []}
          onClose={() => setAdding(undefined)}
          onAdded={() => void api.groups(sessionId).then(setGroups, setError)}
        />
      ) : null}
    </div>
  )
}
