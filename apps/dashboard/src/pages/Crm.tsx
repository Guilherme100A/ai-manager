import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { getToken, onTokenChange } from '../lib/auth'
import { subscribeRoute } from '../lib/router'
import { createCrmAttempt, type CrmState } from './Crm.logic'

/** Inline controller: the actual dashboard page and Layout stay mounted. */
export function Crm({ flowId, metaDestination, onPending }: { flowId?: string; metaDestination?: string; onPending: (pending: boolean) => void }) {
  const [state, setState] = useState<CrmState>({ kind: 'loading' })
  const attempt = useRef<ReturnType<typeof createCrmAttempt> | null>(null)
  useEffect(() => {
    let alive = true
    const hash = window.location.hash
    const token = getToken()
    const controller = createCrmAttempt(api.crmSso, (url) => { if (window.location.hash === hash && getToken() === token) window.location.replace(url) }, (next) => {
      setState(next)
      onPending(next.kind === 'loading')
    }, flowId ? `/flows/${encodeURIComponent(flowId)}/edit` : metaDestination)
    attempt.current = controller
    // Fence at the event, before effect cleanup, including A -> B -> A.
    const stopRoute = subscribeRoute(() => { if (window.location.hash !== hash) controller.invalidate() })
    const stopToken = onTokenChange(() => controller.invalidate())
    // StrictMode's discarded setup never starts a request.
    void Promise.resolve().then(() => { if (alive) void controller.start() })
    return () => {
      alive = false
      controller.invalidate()
      stopRoute()
      stopToken()
      attempt.current = null
    }
  }, [flowId, metaDestination, onPending])
  if (state.kind === 'loading') return null
  return (
    <div className="crm-inline-notice" data-testid={state.kind === 'disabled' ? 'crm-disabled' : 'crm-error'} role="alert">
      <p>{state.kind === 'disabled' ? 'Integração CRM desligada.' : state.kind === 'error' ? state.message : ''}</p>
      <button type="button" onClick={() => void attempt.current?.start()}>Tentar novamente</button>
    </div>
  )
}
