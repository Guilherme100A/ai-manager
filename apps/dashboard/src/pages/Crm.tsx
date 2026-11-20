// O CRM é a entrada principal. O SSO navega para /crm/ na mesma aba; o painel de sessões
// permanece disponível pelo item próprio no menu do CRM.
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { crmEntryUrl, crmErrorState, type CrmState } from './Crm.logic'

export function Crm({ flowId, metaDestination }: { flowId?: string; metaDestination?: string }) {
  const [state, setState] = useState<CrmState>({ kind: 'loading' })

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    api
      .crmSso()
      .then(({ url }) => {
        const target = flowId ? `/flows/${encodeURIComponent(flowId)}/edit` : metaDestination
        const destination = crmEntryUrl(url, target)
        if (!destination) {
          setState({ kind: 'error', message: 'O servidor devolveu uma URL do CRM inválida.' })
          return
        }
        window.location.replace(destination)
      })
      .catch((err: unknown) => setState(crmErrorState(err)))
  }, [flowId, metaDestination])

  useEffect(load, [load])

  return (
    <div className="crm-shell" data-testid="page-crm">
      <div className="crm-body">
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
        ) : <p className="crm-status empty">Abrindo o CRM…</p>}
      </div>
    </div>
  )
}
