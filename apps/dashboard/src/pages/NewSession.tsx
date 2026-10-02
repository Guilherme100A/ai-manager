// "+ Adicionar número" (AC-T12-04, AC-T18-02): cria a sessão com o proxy inline e autentica por QR ou pairing code.
import { useEffect, useState, type FormEvent } from 'react'
import { ProxyFields } from '../components/ProxyFields'
import { ErrorText, PageHeader, StateIndicator } from '../components/ui'
import { api } from '../lib/api'
import { POLL } from '../lib/hooks'
import { emptyProxyForm, parseNewSessionProxy, type ProxyInput } from '../lib/proxy-form'
import { routeHref } from '../lib/router'
import type { Session, SessionState } from '../lib/types'

type Mode = 'qr' | 'pairing'

export function NewSession() {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  // T22: chip pessoal conecta direto pelo IP da máquina (padrão); desmarcado, o proxy é obrigatório.
  const [direct, setDirect] = useState(true)
  const [proxy, setProxy] = useState(emptyProxyForm)
  const [proxyError, setProxyError] = useState<string>()
  const [note, setNote] = useState('')
  const [session, setSession] = useState<Session>()
  const [mode, setMode] = useState<Mode>()
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState<string>()
  const [state, setState] = useState<SessionState>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)

  const connected = state !== undefined && state !== 'NEW' && state !== 'DISCONNECTED'
  const waiting = !!session && !!mode && !connected

  // Polling do estado (e do QR) até conectar.
  useEffect(() => {
    if (!session || !mode || connected) return
    let alive = true
    const timer = setInterval(async () => {
      try {
        const s = await api.session(session.id)
        if (!alive) return
        setState(s.status)
        if (mode === 'qr' && s.status === 'NEW') {
          const info = await api.getQr(session.id)
          if (alive && info.qr) setQr(info.qr)
        }
      } catch (err) {
        if (alive) setError(err)
      }
    }, POLL.fast)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [session, mode, connected])

  async function ensureSession(proxyInput: ProxyInput | null): Promise<Session> {
    if (session) return session
    const created = await api.createSession({
      name: name.trim(),
      phone: phone.trim() || null,
      ...(proxyInput ? { proxy: proxyInput } : {}),
      note: note.trim() || null,
    })
    setSession(created)
    setState(created.status)
    return created
  }

  async function start(e: FormEvent | undefined, m: Mode) {
    e?.preventDefault()
    // Validação do proxy no cliente, antes de qualquer chamada à API (sessão já criada: o bloco fica travado).
    const parsed = session ? ({ ok: true, proxy: null } as const) : parseNewSessionProxy(direct, proxy)
    setProxyError(parsed.ok ? undefined : parsed.error)
    if (!parsed.ok) return
    // O pairing code é gerado para um número; no QR o número é lido da conta ao conectar.
    if (m === 'pairing' && !phone.trim() && !session?.phone) {
      setError(new Error('Informe o número para gerar o pairing code (ou use o QR Code, que não precisa).'))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const s = await ensureSession(parsed.proxy)
      setMode(m)
      if (m === 'qr') {
        setCode(undefined)
        await api.startQr(s.id)
        const info = await api.getQr(s.id)
        if (info.qr) setQr(info.qr)
      } else {
        setQr(null)
        const r = await api.pairingCode(s.id, phone.trim() || undefined)
        setCode(r.code)
      }
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="page-new-session">
      <PageHeader title="Adicionar número" subtitle="Cadastre o número e o proxy e autentique por QR Code ou pairing code.">
        <a className="button secondary-link" href={routeHref({ name: 'sessions' })}>
          Voltar
        </a>
      </PageHeader>
      <form className="panel form" onSubmit={(e) => start(e, 'qr')}>
        <label htmlFor="new-name">Nome</label>
        <input id="new-name" data-testid="new-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!!session} required />
        <label htmlFor="new-phone">Número</label>
        <input
          id="new-phone"
          data-testid="new-phone"
          placeholder="+5511999999999"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={!!session}
          aria-describedby="new-phone-hint"
        />
        <p className="hint" id="new-phone-hint">
          Opcional no QR Code: o número é preenchido sozinho quando o WhatsApp conecta. Obrigatório só para o pairing code.
        </p>
        <label className="check direct-connection" htmlFor="new-direct-connection">
          <input
            id="new-direct-connection"
            data-testid="new-direct-connection"
            type="checkbox"
            checked={direct}
            disabled={!!session}
            aria-controls="new-proxy-fields"
            onChange={(e) => {
              setDirect(e.target.checked)
              setProxyError(undefined)
            }}
          />
          <span>Chip pessoal / conexão direta (sem proxy)</span>
        </label>
        {direct ? <p className="hint direct-hint">O número conecta pelo IP desta máquina. Desmarque para usar um proxy.</p> : null}
        <ProxyFields prefix="new-proxy" value={proxy} onChange={(v) => setProxy(v)} disabled={!!session} hidden={direct} />
        {proxyError ? (
          <p className="error" role="alert" data-testid="new-proxy-error">
            {proxyError}
          </p>
        ) : null}
        <label htmlFor="new-note">Observação</label>
        <textarea id="new-note" data-testid="new-note" value={note} onChange={(e) => setNote(e.target.value)} disabled={!!session} />
        <div className="actions">
          <button type="submit" data-testid="gen-qr" disabled={busy || connected}>
            Gerar QR Code
          </button>
          <button type="button" className="secondary" data-testid="gen-pairing" disabled={busy || connected} onClick={() => start(undefined, 'pairing')}>
            Gerar Pairing Code
          </button>
        </div>
      </form>

      <ErrorText error={error} testId="auth-error" />

      {waiting && mode === 'qr' ? (
        <div className="panel auth">
          <p>Escaneie o QR Code no WhatsApp (Aparelhos conectados). Ele é atualizado até conectar.</p>
          {qr ? <img data-testid="qr-image" src={qr} alt="QR Code" width={264} height={264} /> : <p className="muted">Aguardando QR…</p>}
        </div>
      ) : null}
      {waiting && mode === 'pairing' ? (
        <div className="panel auth">
          <p>Digite o código em WhatsApp → Aparelhos conectados → Conectar com número.</p>
          {code ? (
            <p className="pairing" data-testid="pairing-code">
              {code}
            </p>
          ) : (
            <p className="muted">Aguardando código…</p>
          )}
        </div>
      ) : null}
      {connected && session && state ? (
        <div className="panel auth" data-testid="auth-connected">
          <p>
            Conectado: <StateIndicator state={state} testId="connect-state" />
          </p>
          <a className="button" href={routeHref({ name: 'session', id: session.id })} data-testid="session-open">
            Abrir sessão
          </a>
        </div>
      ) : null}
    </div>
  )
}
