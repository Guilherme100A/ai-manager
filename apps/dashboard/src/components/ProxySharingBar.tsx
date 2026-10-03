import { useEffect, useState } from 'react'
import { api, type ProxySharing } from '../lib/api'
import { usePoll } from '../lib/hooks'
import { ErrorText } from './ui'

/** Botão do limite de chips por IP: liga/desliga num clique; o máximo por IP é editável. */
export function ProxySharingBar() {
  const { data, error } = usePoll(() => api.proxySharing(), 0)
  const [settings, setSettings] = useState<ProxySharing>()
  const [max, setMax] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<unknown>()

  useEffect(() => {
    if (data && !settings) { setSettings(data); setMax(String(data.maxSessionsPerIp)) }
  }, [data, settings])

  async function save(next: ProxySharing) {
    setBusy(true)
    setSaveError(undefined)
    try {
      const saved = await api.saveProxySharing(next)
      setSettings(saved)
      setMax(String(saved.maxSessionsPerIp))
    } catch (err) {
      setSaveError(err)
      if (settings) setMax(String(settings.maxSessionsPerIp))
    } finally {
      setBusy(false)
    }
  }

  function saveMax() {
    const value = Number(max)
    if (!settings || !Number.isInteger(value) || value === settings.maxSessionsPerIp) { if (settings) setMax(String(settings.maxSessionsPerIp)); return }
    void save({ ...settings, maxSessionsPerIp: value })
  }

  return (
    <section className="panel proxy-sharing" aria-label="Limite de chips por IP" data-testid="proxy-sharing">
      <div className="proxy-sharing-row">
        <div>
          <strong>Limite de chips por IP</strong>
          <p className="muted">
            {settings ? (settings.enabled ? `Ligado: no máximo ${settings.maxSessionsPerIp} chip(s) no mesmo IP de proxy.` : 'Desligado: sem limite de chips por IP.') : 'Carregando…'}
          </p>
        </div>
        <label className="proxy-sharing-max">
          Máximo por IP
          <input type="number" min={1} max={50} value={max} disabled={!settings || busy} data-testid="proxy-sharing-max"
            onChange={(e) => setMax(e.target.value)} onBlur={saveMax} onKeyDown={(e) => { if (e.key === 'Enter') saveMax() }} />
        </label>
        <button type="button" className={settings?.enabled ? '' : 'secondary'} disabled={!settings || busy} data-testid="proxy-sharing-toggle"
          aria-pressed={settings?.enabled ?? false} onClick={() => settings && void save({ ...settings, enabled: !settings.enabled })}>
          {settings?.enabled ? 'Ligado' : 'Desligado'}
        </button>
      </div>
      <p className="hint">Vale ao cadastrar um chip ou trocar o proxy dele; chips que já estão no mesmo IP continuam funcionando.</p>
      <ErrorText error={error ?? saveError} />
    </section>
  )
}
