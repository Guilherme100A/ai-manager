import { useCallback, useEffect, useState } from 'react'
import { request } from '../lib/api'
import { formatDateTime } from '../lib/aggregate'
import { ErrorText } from './ui'

interface Chat {
  phone: string; name: string | null; isSession: boolean
  total: number; sent: number; received: number
  lastAt: string; lastText: string | null; lastDirection: 'inbound' | 'outbound'
}
interface ChatMessage {
  id: string; direction: 'inbound' | 'outbound'; status: string
  text: string | null; kind: string; error: string | null; createdAt: string; sentAt: string | null
}

const KIND_LABEL: Record<string, string> = { sticker: 'Figurinha', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', document: 'Documento', other: 'Mensagem' }
const STATUS_LABEL: Record<string, string> = {
  queued: 'na fila', processing: 'enviando', retrying: 'tentando de novo', sent: 'enviada', delivered: 'entregue',
  read: 'lida', failed: 'falhou', cancelled: 'cancelada',
}
const body = (m: Pick<ChatMessage, 'text' | 'kind'>) => m.kind === 'text' ? m.text : `[${KIND_LABEL[m.kind] ?? 'Mensagem'}]${m.text ? ` ${m.text}` : ''}`

/**
 * Conversas do chip lidas do banco. Sem atualização automática: carrega ao abrir e no botão "Atualizar".
 * Nada aqui fala com o WhatsApp, então ver as conversas não gasta envio nem conta nos limites.
 */
export function ChatsPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [chats, setChats] = useState<Chat[]>()
  const [phone, setPhone] = useState<string>()
  const [messages, setMessages] = useState<ChatMessage[]>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/chats`

  const load = useCallback(async (selected?: string) => {
    setBusy(true); setError(undefined)
    try {
      const [list, thread] = await Promise.all([
        request<{ items: Chat[] }>(base),
        selected ? request<{ items: ChatMessage[] }>(`${base}/${encodeURIComponent(selected)}`) : undefined,
      ])
      setChats(list.items)
      setMessages(thread?.items)
    } catch (err) { setError(err) } finally { setBusy(false) }
  }, [base])

  useEffect(() => { if (open && !chats) void load() }, [open, chats, load])

  const select = (p: string) => { setPhone(p); setMessages(undefined); void load(p) }
  const current = chats?.find((c) => c.phone === phone)

  return <section className="panel" aria-label="Conversas do chip">
    <div className="row chats-head">
      <h2>Conversas</h2>
      <button type="button" className="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Fechar' : 'Ver conversas'}</button>
      {open ? <button type="button" className="secondary" disabled={busy} onClick={() => void load(phone)}>{busy ? 'Carregando…' : 'Atualizar'}</button> : null}
    </div>
    <p className="hint">Histórico salvo no painel. Não atualiza sozinho e não usa o WhatsApp: abrir as conversas não gasta envios nem mexe nos limites do chip.</p>
    <ErrorText error={error} />
    {open && chats ? <div className="chats">
      <ul className="chats-list" aria-label="Contatos">
        {chats.length ? chats.map((c) => <li key={c.phone}>
          <button type="button" className={c.phone === phone ? 'active' : ''} aria-current={c.phone === phone || undefined} onClick={() => select(c.phone)}>
            <span className="chats-name">{c.name ?? c.phone}{c.isSession ? <span className="tag">chip</span> : null}</span>
            <span className="chats-meta">{c.name ? `${c.phone} · ` : ''}{c.sent} enviadas · {c.received} recebidas</span>
            <span className="chats-last">{c.lastDirection === 'outbound' ? 'Você: ' : ''}{c.lastText ?? '[mídia]'}</span>
            <span className="chats-meta">{formatDateTime(c.lastAt)}</span>
          </button>
        </li>) : <li className="hint">Nenhuma conversa ainda.</li>}
      </ul>
      <div className="chats-thread" aria-live="polite">
        {!phone ? <p className="hint">Escolha uma conversa.</p> : !messages ? <p className="hint">Carregando…</p> : <>
          <p className="chats-title">{current?.name ?? phone}{current?.name ? <span className="hint"> {phone}</span> : null}</p>
          {messages.length === 200 ? <p className="hint">Mostrando as 200 mensagens mais recentes.</p> : null}
          <ol className="chats-messages">
            {messages.map((m) => <li key={m.id} className={m.direction === 'outbound' ? 'out' : 'in'}>
              <span className="chats-bubble">{body(m)}</span>
              <span className="chats-meta">{formatDateTime(m.createdAt)}{m.direction === 'outbound' ? ` · ${STATUS_LABEL[m.status] ?? m.status}` : ''}</span>
              {m.status === 'failed' && m.error ? <span className="chats-meta error">{m.error}</span> : null}
            </li>)}
          </ol>
        </>}
      </div>
    </div> : null}
  </section>
}
