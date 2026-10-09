import { useEffect, useState } from 'react'
import { api, request } from '../lib/api'
import { ErrorText } from './ui'
import type { Session } from '../lib/types'

interface Config {
  mode: 'fixed' | 'rotating'
  enabled: boolean; targetSessionId: string | null; topic: string; maxMessagesPerDay: number
  turnsPerConversation: number; intervalMinutes: number
}
interface View {
  config: Config
  activePartnerId: string | null
  state: { halted?: boolean; turns: number; nextAt?: number; lastError?: string; pending: { senderId: string; receiverId: string } | null }
  accounts: Array<{ id: string; used24h: number; dailyLimit: number }>
}
export function ConversationPanel({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<View>()
  const [config, setConfig] = useState<Config>()
  const [sessions, setSessions] = useState<Session[]>([])
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/conversation`
  useEffect(() => {
    let active = true
    setView(undefined); setConfig(undefined); setError(undefined)
    const load = async (initial = false) => {
      try {
        const result = await request<View>(endpoint)
        if (active) { setView(result); if (initial) setConfig(result.config) }
      } catch (err) { if (active) setError(err) }
    }
    void load(true)
    void api.sessions().then((value) => { if (active) setSessions(value) }, (err) => { if (active) setError(err) })
    const timer = setInterval(() => void load(), 10_000)
    return () => { active = false; clearInterval(timer) }
  }, [endpoint])
  async function save() {
    if (!config) return
    setBusy(true); setError(undefined)
    try { setView(await request<View>(endpoint, { method: 'PUT', body: config })) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }
  async function run() {
    setBusy(true); setError(undefined)
    try { await request(`${endpoint}/run`, { method: 'POST' }); setView(await request<View>(endpoint)) }
    catch (err) { setError(err) } finally { setBusy(false) }
  }
  return <section className="panel" aria-label="Conversas entre contas">
    <h2>Conversas entre contas</h2>
    <p className="hint">Ative o rodízio nas contas que podem conversar. O sistema distribui os pares, prioriza quem ficou esperando e troca parceiros entre rodadas. Cada conta participa de uma conversa por vez, usando seus limites de envio.</p>
    <ErrorText error={error} />
    {config ? <>
      <label><input type="checkbox" checked={config.enabled} disabled={busy} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} /> Ativar conversas nesta conta</label>
      <div className="dialog-field"><label htmlFor="conversation-mode">Distribuição</label>
        <select id="conversation-mode" disabled={busy} value={config.mode} onChange={(e) => setConfig({ ...config, mode: e.target.value as Config['mode'], targetSessionId: null })}>
          <option value="rotating">Rodízio automático entre contas habilitadas</option><option value="fixed">Par fixo escolhido por mim</option>
        </select>
      </div>
      {config.mode === 'fixed' ? <div className="dialog-field"><label htmlFor="conversation-target">Outra conta</label>
        <select id="conversation-target" disabled={busy} value={config.targetSessionId ?? ''} onChange={(e) => setConfig({ ...config, targetSessionId: e.target.value || null })}>
          <option value="">Selecione…</option>
          {sessions.filter((s) => s.id !== sessionId).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.phone ?? 'sem número'})</option>)}
        </select>
        <small className="hint">Autorize os dois números em Contatos. Ative o par apenas aqui; não é necessário criar o vínculo inverso na outra conta.</small>
      </div> : <p className="hint">Ative também o rodízio nas outras contas. Só entram no sorteio contas conectadas e com cota. Se o número de contas for ímpar, quem ficar de fora ganha prioridade na próxima formação.</p>}
      <div className="dialog-field"><label htmlFor="conversation-topic">Tema</label><input id="conversation-topic" value={config.topic} maxLength={300} disabled={busy} onChange={(e) => setConfig({ ...config, topic: e.target.value })} /></div>
      {([{ key: 'maxMessagesPerDay', label: 'Teto de envios por conta em 24 horas', min: 1, max: 800 },
        { key: 'turnsPerConversation', label: 'Falas por rodada (somando as duas contas)', min: 2, max: 10 },
        { key: 'intervalMinutes', label: 'Intervalo entre falas em minutos', min: 1, max: 60 }] as const).map(({ key, label, min, max }) =>
        <div className="dialog-field" key={key}><label htmlFor={`conversation-${key}`}>{label}</label><input id={`conversation-${key}`} type="number" min={min} max={max} value={config[key]} disabled={busy} onChange={(e) => setConfig({ ...config, [key]: Number(e.target.value) })} /></div>)}
      <p className="hint">O volume por dia acompanha o aquecimento (o limite inteiro do dia, no mínimo 20) até este teto. Ao terminar uma rodada, o par aguarda 30 minutos. A ativação não garante melhora do score.</p>
      <div className="row"><button type="button" disabled={busy || !config.topic.trim() || (config.enabled && config.mode === 'fixed' && !config.targetSessionId)} onClick={() => void save()}>Salvar conversas</button>
        <button type="button" className="secondary" disabled={busy || !view?.config.enabled || view.state.halted} onClick={() => void run()}>Verificar ciclo agora</button></div>
    </> : null}
    {view ? <>
      <p role="status">{view.state.halted ? 'Conversa interrompida' : !view.config.enabled ? 'Desativada' : view.state.pending ? 'Aguardando envio e recebimento' : 'Aguardando próxima fala'} · {view.state.turns} falas confirmadas nesta rodada</p>
      <p className="hint">Parceiro atual: {view.activePartnerId ? sessions.find((s) => s.id === view.activePartnerId)?.name ?? view.activePartnerId : 'Aguardando distribuição'}</p>
      {view.accounts.map((a) => <p className="hint" key={a.id}>{sessions.find((s) => s.id === a.id)?.name ?? a.id}: {a.used24h}/{a.dailyLimit} envios nas últimas 24 horas, incluindo outras atividades.</p>)}
      {view.state.lastError ? <p className="error">{view.state.lastError}</p> : null}
    </> : null}
  </section>
}
