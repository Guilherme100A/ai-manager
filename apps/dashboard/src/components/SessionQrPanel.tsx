import { useState } from 'react'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import type { Session } from '../lib/types'
import { ErrorText } from './ui'

/** Autentica a sessão existente sem criar outro número nem apagar credenciais. */
export function SessionQrPanel({ session, onChanged }: { session: Session; onChanged: () => void }) {
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<unknown>()
  const poll = usePoll(async () => {
    if (!attempt || busy) return null
    const current = await api.session(session.id)
    if (current.status !== 'NEW' && current.status !== 'DISCONNECTED') onChanged()
    const info = current.status === 'NEW' ? await api.getQr(session.id) : null
    return { attempt, state: current.status, qr: info?.qr ?? null }
  }, attempt && !busy ? POLL.fast : 0, [session.id, attempt, busy])
  const result = poll.data?.attempt === attempt && !busy ? poll.data : null
  const qr = poll.error || actionError ? null : result?.qr
  const disconnected = result?.state === 'DISCONNECTED'

  async function start() {
    setBusy(true)
    setActionError(undefined)
    try {
      await api.startQr(session.id)
      setAttempt((a) => a + 1)
      onChanged()
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel auth" data-testid="session-qr-panel">
      <h2>Conectar WhatsApp</h2>
      <p>Gere o QR desta sessão e escaneie em WhatsApp → Aparelhos conectados → Conectar aparelho.</p>
      <button type="button" data-testid="session-gen-qr" disabled={busy} onClick={() => void start()}>
        {busy ? 'Gerando QR…' : attempt ? 'Tentar novamente' : 'Gerar QR Code'}
      </button>
      <ErrorText error={actionError ?? poll.error} testId="session-qr-error" />
      {disconnected ? <p role="alert">A conexão foi encerrada. Confira o proxy e gere o QR novamente.</p> : null}
      {qr ? <img data-testid="qr-image" src={qr} alt="QR Code do WhatsApp" width={264} height={264} /> : attempt && !disconnected ? <p role="status">Aguardando QR…</p> : null}
    </section>
  )
}
