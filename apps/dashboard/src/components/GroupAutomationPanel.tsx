import { useEffect, useState } from 'react'
import { request } from '../lib/api'
import type { Session } from '../lib/types'
import { ErrorText } from './ui'

interface Config { enabled: boolean; query: string; maxEntriesPerDay: number; targetSessionId: string | null }
interface View {
  config: Config
  capacity: { dailyEntryLimit: number; usedEntries24h: number; remainingEntries: number }
  currentGroups: number
  groups: Array<{ id: string; name: string; state: string; lastPostDay?: string }>
  lastError: string | null
  running: boolean
}

export function GroupAutomationPanel({ sessionId, sessions }: { sessionId: string; sessions: Session[] }) {
  const [view, setView] = useState<View>()
  const [config, setConfig] = useState<Config>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/groups/automation`
  useEffect(() => {
    let active = true
    setView(undefined)
    setConfig(undefined)
    setError(undefined)
    const load = async (initial = false) => {
      try {
        const result = await request<View>(endpoint)
        if (active) { setView(result); if (initial) setConfig(result.config) }
      } catch (err) { if (active) setError(err) }
    }
    void load(true)
    const timer = setInterval(() => void load(), 10_000)
    return () => { active = false; clearInterval(timer) }
  }, [endpoint])

  async function save() {
    if (!config) return
    setBusy(true)
    setError(undefined)
    try { setView(await request<View>(endpoint, { method: 'PUT', body: config })) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }
  async function run() {
    setBusy(true)
    setError(undefined)
    try { await request(`${endpoint}/run`, { method: 'POST' }); setView(await request<View>(endpoint)) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }

  return <section className="panel" aria-label="Automação de grupos">
    <h2>Entrada automática e mensagem diária</h2>
    <p className="hint">Busca grupos públicos com o modelo pequeno, entra conforme o limite de entradas da conta e envia uma mensagem por dia sobre o tema. O volume recebido no grupo não limita as entradas.</p>
    <ErrorText error={error} />
    {config ? <>
      <label><input type="checkbox" checked={config.enabled} disabled={busy} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} /> Ativar nesta conta</label>
      <div className="dialog-field">
        <label htmlFor="auto-group-query">Temas para buscar</label>
        <input id="auto-group-query" maxLength={300} value={config.query} disabled={busy} onChange={(e) => setConfig({ ...config, query: e.target.value })} />
      </div>
      <div className="dialog-field">
        <label htmlFor="auto-group-max">Teto de entradas por 24 horas (o nível da conta pode permitir menos)</label>
        <input id="auto-group-max" type="number" min={1} max={20} value={config.maxEntriesPerDay} disabled={busy} onChange={(e) => setConfig({ ...config, maxEntriesPerDay: Number(e.target.value) })} />
      </div>
      <div className="dialog-field">
        <label htmlFor="auto-group-target">Outra conta para receber o convite</label>
        <select id="auto-group-target" disabled={busy} value={config.targetSessionId ?? ''} onChange={(e) => setConfig({ ...config, targetSessionId: e.target.value || null })}>
          <option value="">Sortear outra conta com automação ativa</option>
          {sessions.filter((s) => s.id !== sessionId).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.phone ?? 'sem número'})</option>)}
        </select>
        <small className="hint">Ative a automação também na conta destinatária e autorize o número dela em Contatos. Ela só entra se tiver capacidade disponível.</small>
      </div>
      <div className="row">
        <button type="button" disabled={busy || !config.query.trim()} onClick={() => void save()}>Salvar automação</button>
        <button type="button" className="secondary" disabled={busy || !view?.config.enabled || view.running} onClick={() => void run()}>Executar ciclo agora</button>
      </div>
    </> : null}
    {view ? <>
      <p role="status">{view.running ? 'Processando…' : view.config.enabled ? 'Automação ativa' : 'Automação desativada'} · Entradas/tentativas: {view.capacity.usedEntries24h}/{view.capacity.dailyEntryLimit} nas últimas 24h</p>
      <p className="hint">Entradas disponíveis: {view.capacity.remainingEntries}. Total de grupos da conta: {view.currentGroups}. A mensagem diária respeita os limites de envio.</p>
      {view.lastError ? <p className="error">{view.lastError}</p> : null}
      {view.groups.map((g) => <p key={g.id}>{g.name || g.id} — {g.state === 'joined' ? 'Entrou' : 'Aguardando confirmação'}{g.lastPostDay ? ` · Mensagem diária reservada em ${g.lastPostDay}` : ''}</p>)}
    </> : null}
  </section>
}
