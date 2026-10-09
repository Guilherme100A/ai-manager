// Números de autoresposta (próprios do operador): os chips com proxy conversam com eles além do rodízio entre chips.
import { useState, type FormEvent } from 'react'
import { ErrorText, PageHeader } from '../components/ui'
import { formatDateTime } from '../lib/aggregate'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'

export function AutoReply() {
  const { data, error, reload } = usePoll(() => api.autoReplyTargets(), POLL.page)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>()
  const [formError, setFormError] = useState<unknown>()

  async function add(e: FormEvent) {
    e.preventDefault()
    const phones = text.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean)
    if (!phones.length) return
    setBusy(true)
    setFormError(undefined)
    setStatus(undefined)
    try {
      const r = await api.addAutoReplyTargets(phones)
      setStatus(`${r.added.length} número(s) na lista.${r.invalid.length ? ` Inválidos (ignorados): ${r.invalid.join(', ')}` : ''}`)
      setText('')
      reload()
    } catch (err) {
      setFormError(err)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string, phone: string) {
    if (!window.confirm(`Tirar ${phone} da lista? Os chips param de mandar para ele.`)) return
    setFormError(undefined)
    try {
      await api.removeAutoReplyTarget(id)
      reload()
    } catch (err) {
      setFormError(err)
    }
  }

  return (
    <div data-testid="page-autoreply">
      <PageHeader
        title="Autoresposta"
        subtitle="Números próprios que respondem sozinhos. Só os chips com proxy conversam com eles, dentro do mesmo limite diário do chip."
      />
      <ErrorText error={error} />
      <form className="panel form" onSubmit={add}>
        <label htmlFor="autoreply-phones">Adicionar números (um por linha, com DDI e DDD; ex.: 5511999990000)</label>
        <textarea id="autoreply-phones" data-testid="autoreply-phones" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" data-testid="autoreply-add" disabled={busy || !text.trim()}>{busy ? 'Adicionando…' : 'Adicionar'}</button>
        {status ? <p className="muted" data-testid="autoreply-status">{status}</p> : null}
        <ErrorText error={formError} />
      </form>
      <p className="muted">
        Cada chip com proxy manda, a cada intervalo da conversa dele, 1 ou 2 mensagens para o número que está há mais tempo
        sem receber dele (no máximo uma vez por hora para o mesmo número). As respostas automáticas não viram sugestão da IA.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Número</th>
              <th>Enviadas (24 h)</th>
              <th>Respostas (24 h)</th>
              <th>Última mensagem</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((t) => (
              <tr key={t.id} data-testid="autoreply-row">
                <td className="mono cell-strong">{t.phone}</td>
                <td>{t.sent24h}</td>
                <td className={t.sent24h > 0 && t.replies24h === 0 ? 'report-warn' : undefined}>{t.replies24h}</td>
                <td className="muted">{formatDateTime(t.lastSentAt)}</td>
                <td className="cell-delete">
                  <button type="button" className="danger btn-sm" data-testid="autoreply-remove" onClick={() => void remove(t.id, t.phone)}>
                    Remover
                  </button>
                </td>
              </tr>
            ))}
            {data && data.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">Nenhum número na lista</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
