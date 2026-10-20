import { useState, type FormEvent } from 'react'
import { Card, ErrorText, PageHeader } from '../components/ui'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import type { SpyAd, SpyEnqueueResult, SpyProbe } from '../lib/types'
import { adLibraryUrl, formatPhone, parseLinks, PROBES_PER_DAY, probeStatusLabel, rowTitle, SENDABLE, STATUS_LABEL, summarize, VIA_LABEL } from './Spy.logic'

export function Spy() {
  const ads = usePoll(() => api.spyAds(), POLL.list)
  const offers = usePoll(() => api.spyOffers(), POLL.page)
  const probes = usePoll(() => api.spyProbes(), POLL.page)
  const sessions = usePoll(() => api.sessions(), POLL.page)
  const sendable = sessions.data?.filter((s) => SENDABLE.includes(s.status)) ?? []
  const [chip, setChip] = useState<Record<string, string>>({})
  const [openProbe, setOpenProbe] = useState<string>()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [last, setLast] = useState<SpyEnqueueResult>()
  const [manual, setManual] = useState<Record<string, string>>({})
  const links = parseLinks(text)
  const rows = ads.data?.filter((a) => a.status !== 'expandido') ?? []
  const searches = ads.data?.filter((a) => a.status === 'expandido') ?? []
  const stats = summarize(ads.data ?? [])

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try { await action(); ads.reload(); offers.reload(); probes.reload() }
    catch (err) { setError(err) }
    finally { setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    await mutate(async () => {
      setLast(await api.spyEnqueue(links.slice(0, 50)))
      setText('')
    })
  }

  return <div data-testid="page-spy">
    <PageHeader title="Espião" subtitle="Cole os links dos anúncios: o sistema acha o WhatsApp de cada oferta, sem login no Facebook." />
    <form className="panel stack" onSubmit={submit}>
      <h2>Adicionar anúncios</h2>
      <label>Links (um por linha)
        <textarea data-testid="spy-links" rows={5} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'https://www.facebook.com/ads/library/?id=1234567890\nhttps://www.facebook.com/ads/library/?q=receita&country=BR…\nhttps://wa.me/5511999999999'} />
      </label>
      <p className="muted">Aceita anúncio da Biblioteca, busca da Biblioteca (pega os anúncios de WhatsApp da busca), post ou vídeo da página e wa.me. Caminho: link do anúncio → texto → posts do perfil (permalink com o botão do WhatsApp) → página Sobre. Um anúncio por vez, devagar, para não ser bloqueado.</p>
      <button data-testid="spy-submit" disabled={busy || links.length === 0}>{links.length > 50 ? 'Adicionar os 50 primeiros' : links.length === 0 ? 'Adicionar links' : links.length === 1 ? 'Adicionar 1 link' : `Adicionar ${links.length} links`}</button>
      {last && <p className="muted" data-testid="spy-last">{last.created.length} na fila{last.skipped.length > 0 && `; ignorados: ${last.skipped.map((s) => `${s.link} (${s.reason})`).join(', ')}`}</p>}
    </form>
    <ErrorText error={error ?? ads.error ?? offers.error ?? probes.error} />

    <div className="cards">
      <Card testId="spy-total" title="Anúncios" value={stats.total} />
      <Card testId="spy-pending" title="Na fila" value={stats.pending} />
      <Card testId="spy-found" title="Com número" value={stats.found} />
      <Card testId="spy-missing" title="Sem número" value={stats.missing} />
    </div>

    <section className="panel stack">
      <h2>Ofertas (por número)</h2>
      <p className="muted">Sondar: o chip escolhido conversa com a oferta como um lead (IA), com atraso humano, até o preço/checkout, sem pagar e sem passar dados reais. Depois continua só ouvindo por 7 dias para gravar o remarketing. Até {PROBES_PER_DAY} sondas novas por chip por dia.</p>
      <div className="table-wrap"><table className="spy-table" data-testid="spy-offers">
        <thead><tr><th>WhatsApp</th><th>Página</th><th>Anúncios</th><th>Sondar com</th></tr></thead>
        <tbody>
          {offers.data?.map((o) => {
            const active = probes.data?.some((p) => p.offerId === o.id && p.status === 'ativa')
            return <tr key={o.id}>
              <td><a href={`https://wa.me/${o.phone}`} target="_blank" rel="noreferrer">{formatPhone(o.phone)}</a></td>
              <td>{o.pageName ?? '—'}</td>
              <td>{o.ads}</td>
              <td className="cell-actions">
                {active ? <span className="tag">Sondando</span> : <>
                  <select aria-label="Chip da sonda" value={chip[o.id] ?? ''} onChange={(e) => setChip((c) => ({ ...c, [o.id]: e.target.value }))}>
                    <option value="">Escolha o chip</option>
                    {sendable.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
                  </select>{' '}
                  <button type="button" className="secondary btn-sm" disabled={busy || !chip[o.id]} onClick={() => mutate(() => api.spyStartProbe(o.id, chip[o.id]!))}>Sondar</button>
                </>}
              </td>
            </tr>
          })}
          {offers.data?.length === 0 && <tr><td colSpan={4}>Nenhuma oferta ainda.</td></tr>}
        </tbody>
      </table></div>
    </section>

    <section className="panel stack" data-testid="spy-probes">
      <h2>Sondas</h2>
      {probes.data?.length === 0 && <p className="muted">Nenhuma sonda. Escolha um chip numa oferta acima e clique em Sondar.</p>}
      {probes.data?.map((p) => <ProbeCard key={p.id} probe={p} busy={busy} open={openProbe === p.id}
        onToggle={() => setOpenProbe((id) => (id === p.id ? undefined : p.id))}
        onStop={() => mutate(() => api.spyStopProbe(p.id))} />)}
    </section>

    <div className="table-wrap"><table className="spy-table" data-testid="spy-ads">
      <thead><tr><th>Página / anúncio</th><th>Estado</th><th>Número</th><th>Ações</th></tr></thead>
      <tbody>
        {rows.map((ad) => <SpyRow key={ad.id} ad={ad} busy={busy} manual={manual[ad.id] ?? ''}
          onManual={(v) => setManual((m) => ({ ...m, [ad.id]: v }))}
          onSave={() => mutate(async () => { await api.spySetPhone(ad.id, manual[ad.id] ?? ''); setManual((m) => ({ ...m, [ad.id]: '' })) })}
          onRetry={() => mutate(() => api.spyRetry(ad.id))}
          onDelete={() => mutate(() => api.spyDelete(ad.id))} />)}
        {ads.data && rows.length === 0 && <tr><td colSpan={4}>Nenhum anúncio. Cole os links acima.</td></tr>}
      </tbody>
    </table></div>
    {searches.length > 0 && <p className="muted">Buscas lidas: {searches.map((s) => s.error).join(' · ')}</p>}
  </div>
}

function SpyRow({ ad, busy, manual, onManual, onSave, onRetry, onDelete }: {
  ad: SpyAd; busy: boolean; manual: string
  onManual: (v: string) => void; onSave: () => void; onRetry: () => void; onDelete: () => void
}) {
  const missing = ad.status === 'sem_numero' || ad.status === 'erro'
  return <tr data-testid="spy-row">
    <td>
      <strong>{ad.pageName ?? rowTitle(ad)}</strong>
      <span className="hint"><a href={adLibraryUrl(ad)} target="_blank" rel="noreferrer">{ad.adArchiveId ? `Anúncio ${ad.adArchiveId}` : ad.inputUrl}</a></span>
      {ad.data.body && <span className="hint">{ad.data.body.slice(0, 90)}{ad.data.body.length > 90 ? '…' : ''}</span>}
    </td>
    <td><span className="tag">{STATUS_LABEL[ad.status]}</span>{ad.error && <span className="hint">{ad.error}</span>}</td>
    <td>
      {ad.phone
        ? <><a href={`https://wa.me/${ad.phone}`} target="_blank" rel="noreferrer">{formatPhone(ad.phone)}</a>
          {ad.foundVia && <span className="hint">{ad.evidenceUrl ? <a href={ad.evidenceUrl} target="_blank" rel="noreferrer">{VIA_LABEL[ad.foundVia]}</a> : VIA_LABEL[ad.foundVia]}</span>}</>
        : missing
          ? <input aria-label="Número do WhatsApp" placeholder="5511999999999" value={manual} onChange={(e) => onManual(e.target.value)} />
          : '—'}
    </td>
    <td className="cell-actions">
      {missing && <button type="button" className="secondary btn-sm" disabled={busy || manual.trim().length < 8} onClick={onSave}>Salvar número</button>}{' '}
      {missing && <button type="button" className="secondary btn-sm" disabled={busy} onClick={onRetry}>Tentar de novo</button>}{' '}
      <button type="button" className="secondary btn-sm" disabled={busy || ad.status === 'lendo'} onClick={onDelete}>Remover</button>
    </td>
  </tr>
}

function ProbeCard({ probe, busy, open, onToggle, onStop }: { probe: SpyProbe; busy: boolean; open: boolean; onToggle: () => void; onStop: () => void }) {
  const s = probe.summary
  return <article className="spy-probe" data-testid="spy-probe">
    <header>
      <strong>{probe.pageName ?? formatPhone(probe.phone.replace(/^\+/, ''))}</strong>
      <span className="tag">{probeStatusLabel(probe, Date.now())}</span>
      <span className="hint">{probe.sessionName ?? 'chip'} · {probe.turns}/{probe.maxTurns} respostas · desde {new Date(probe.startedAt).toLocaleString('pt-BR')}</span>
    </header>
    <dl className="spy-summary">
      {s.etapa && <><dt>Etapa</dt><dd>{s.etapa}</dd></>}
      {s.preco && <><dt>Preço</dt><dd>{s.preco}</dd></>}
      {s.checkout && s.checkout.length > 0 && <><dt>Checkout</dt><dd>{s.checkout.map((c) => /^https?:\/\//.test(c) ? <a key={c} href={c} target="_blank" rel="noreferrer">{c}</a> : <span key={c}>{c}</span>)}</dd></>}
      {s.links && s.links.length > 0 && <><dt>Links</dt><dd>{s.links.map((l) => <a key={l} href={l} target="_blank" rel="noreferrer">{l}</a>)}</dd></>}
      {s.humano && <><dt>Atendimento</dt><dd>parece humano</dd></>}
      {(probe.endedReason ?? s.notas) && <><dt>Nota</dt><dd>{probe.endedReason ?? s.notas}</dd></>}
    </dl>
    <div className="actions">
      <button type="button" className="secondary btn-sm" onClick={onToggle}>{open ? 'Esconder conversa' : 'Ver conversa'}</button>
      {(probe.status === 'ativa' || probe.listenUntil) && <button type="button" className="secondary btn-sm" disabled={busy} onClick={onStop}>Parar</button>}
    </div>
    {open && <ProbeConversation id={probe.id} />}
  </article>
}

function ProbeConversation({ id }: { id: string }) {
  const turns = usePoll(() => api.spyProbeMessages(id), POLL.page, [id])
  return <div className="spy-chat">
    <ErrorText error={turns.error} />
    {turns.data?.length === 0 && <p className="muted">A sonda ainda não mandou a primeira mensagem.</p>}
    {turns.data?.map((t, i) => <p key={i} className={t.de === 'eu' ? 'me' : 'them'}>
      <span>{t.texto}</span><small>{t.de === 'eu' ? 'sonda' : 'oferta'} · {new Date(t.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</small>
    </p>)}
  </div>
}
