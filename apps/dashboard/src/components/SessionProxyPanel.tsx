// Proxy da sessão no detalhe (AC-T18-03): mostra (senha mascarada), edita ou remove via PATCH /api/sessions/:id.
import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { parseProxyForm, proxyFormFrom, proxyLabel, type ProxyFormValues } from '../lib/proxy-form'
import type { Session } from '../lib/types'
import { ProxyFields } from './ProxyFields'
import { ErrorText } from './ui'

export const RESTART_WARNING = 'Reinicie a sessão (restart) para aplicar o novo proxy.'

export function SessionProxyPanel({ session: polled, onChanged }: { session: Session; onChanged?: (s: Session) => void }) {
  // Resposta do PATCH vale até o polling trazer uma versão igual ou mais nova.
  const [local, setLocal] = useState<Session>()
  const session = local && local.id === polled.id && local.updatedAt >= polled.updatedAt ? local : polled
  const proxy = session.proxy ?? null
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<ProxyFormValues>(() => proxyFormFrom(proxy))
  const [formError, setFormError] = useState<string>()
  const [apiError, setApiError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  function open() {
    setForm(proxyFormFrom(proxy))
    setFormError(undefined)
    setApiError(undefined)
    setEditing(true)
  }

  async function patch(next: Parameters<typeof api.updateSession>[1]) {
    if (busy) return
    setNotice('')
    setBusy(true)
    setApiError(undefined)
    try {
      const updated = await api.updateSession(session.id, next)
      setLocal(updated)
      setNotice('Proxy atualizado.')
      onChanged?.(updated)
      setEditing(false)
    } catch (err) {
      setApiError(err)
    } finally {
      setBusy(false)
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    // Senha em branco mantém a atual (o PATCH vai sem `password`).
    const parsed = parseProxyForm(form, { keepPassword: !!proxy?.hasPassword })
    if (!parsed.ok) return setFormError(parsed.error)
    setFormError(undefined)
    await patch({ proxy: parsed.proxy })
  }

  async function remove() {
    await patch({ proxy: null })
  }

  return (
    <section className="panel" data-testid="session-proxy-panel">
      <div className="page-head">
        <h2>Proxy</h2>
        {!editing ? (
          <button type="button" className="secondary" data-testid="proxy-edit" onClick={open}>
            {proxy ? 'Editar proxy' : 'Adicionar proxy'}
          </button>
        ) : null}
      </div>
      <p className="proxy-value" data-testid="detail-proxy">
        <span data-testid="session-proxy">{proxyLabel(proxy)}</span>
        {proxy ? null : <span className="muted"> · Sem proxy (usa o IP desta máquina)</span>}
      </p>
      {editing || session.requiresRestart ? (
        <p className="warning" role="status" data-testid="proxy-restart-warning">
          {RESTART_WARNING}
        </p>
      ) : null}
      {editing ? (
        <form className="form" onSubmit={save}>
          <ProxyFields
            prefix="edit-proxy"
            value={form}
            onChange={setForm}
            disabled={busy}
            passwordPlaceholder={proxy?.hasPassword ? 'em branco mantém a senha atual' : undefined}
          />
          {formError ? (
            <p className="error" role="alert" data-testid="proxy-error">
              {formError}
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" data-testid="proxy-save" disabled={busy}>
              Salvar proxy
            </button>
            <button type="button" className="secondary" data-testid="proxy-cancel" disabled={busy} onClick={() => setEditing(false)}>
              Cancelar
            </button>
            {proxy ? (
              <button type="button" className="danger" data-testid="proxy-remove" disabled={busy} onClick={() => void remove()}>
                Remover proxy
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      {busy || notice ? <p role="status">{busy ? 'Salvando proxy…' : notice}</p> : null}
      <ErrorText error={apiError} testId="proxy-api-error" />
    </section>
  )
}
