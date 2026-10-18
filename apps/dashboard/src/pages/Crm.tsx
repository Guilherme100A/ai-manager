// CRM (integração): "outra parte do site". Ao entrar, o CRM ocupa a tela toda, sem o menu lateral do painel: uma barra
// fina no topo (marca, "Voltar ao painel", recarregar e tema) e, embaixo, o CRM do mesmo origin (/crm/) num iframe com
// o menu próprio dele. Cada entrada pede um token de SSO de vida curta (POST /api/crm/sso), então uma sessão expirada
// do CRM volta a funcionar ao reentrar (ou em "Recarregar").
import { useCallback, useEffect, useState } from 'react'
import { ThemeToggle } from '../components/Layout'
import { IconArrowLeft, IconRefresh, Logo } from '../components/icons'
import { api } from '../lib/api'
import { routeHref, type Route } from '../lib/router'
import { crmErrorState, safeCrmUrl, type CrmState } from './Crm.logic'

export function Crm({ back }: { back: Route }) {
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
    <div className="crm-shell" data-testid="page-crm">
      <header className="crm-topbar" data-testid="crm-topbar">
        <a className="crm-back" href={routeHref(back)} data-testid="crm-back" title="Voltar ao painel do ai-manager">
          <IconArrowLeft />
          <span className="crm-back-long">Voltar ao painel</span>
          <span className="crm-back-short">Painel</span>
        </a>
        <span className="crm-topbar-sep" aria-hidden="true" />
        <span className="crm-brand">
          <Logo />
          <span>CRM</span>
        </span>
        <span className="crm-topbar-spacer" />
        <button
          type="button"
          className="icon-button"
          data-testid="crm-reload"
          aria-label="Recarregar o CRM"
          title="Recarregar o CRM"
          onClick={load}
          disabled={state.kind === 'loading'}
        >
          <IconRefresh />
        </button>
        <ThemeToggle />
      </header>
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
        ) : (
          <iframe key={state.url} className="crm-frame" data-testid="crm-frame" title="CRM" src={state.url} allow="clipboard-read; clipboard-write; microphone" />
        )}
      </div>
    </div>
  )
}
