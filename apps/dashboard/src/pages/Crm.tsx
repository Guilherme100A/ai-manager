// CRM dentro do painel (integração): pede um token de SSO de vida curta (POST /api/crm/sso) e abre o CRM do mesmo
// origin (/crm/) num iframe que ocupa a área de conteúdo, com o menu do ai-manager em volta.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { crmErrorState, safeCrmUrl, type CrmState } from './Crm.logic'

export function Crm() {
  const [state, setState] = useState<CrmState>({ kind: 'loading' })

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    api
      .crmSso()
      .then(({ url }) => {
        const safe = safeCrmUrl(url)
        setState(safe ? { kind: 'ready', url: safe } : { kind: 'error', message: 'O servidor devolveu uma URL do CRM inválida.' })
      })
      .catch((err: unknown) => setState(crmErrorState(err)))
  }, [])

  useEffect(load, [load])

  return (
    <div className="crm-page" data-testid="page-crm">
      <div className="crm-bar">
        <h1>CRM</h1>
        <div className="crm-bar-actions">
          <button type="button" className="secondary" data-testid="crm-reload" onClick={load} disabled={state.kind === 'loading'}>
            Recarregar
          </button>
        </div>
      </div>
      {state.kind === 'loading' ? (
        <p className="crm-status empty" data-testid="crm-loading">
          Abrindo o CRM…
        </p>
      ) : state.kind === 'disabled' ? (
        <div className="crm-status crm-notice" role="status" data-testid="crm-disabled">
          <strong>Integração CRM desligada.</strong>
          <p>
            Defina <code>CRM_SSO_SECRET</code> na API (o mesmo segredo configurado no CRM) e sirva o CRM em <code>/crm/</code> para usar o CRM
            aqui no painel.
          </p>
        </div>
      ) : state.kind === 'error' ? (
        <p className="crm-status error" role="alert" data-testid="crm-error">
          {state.message}
        </p>
      ) : (
        <iframe key={state.url} className="crm-frame" data-testid="crm-frame" title="CRM" src={state.url} allow="clipboard-read; clipboard-write; microphone" />
      )}
    </div>
  )
}
