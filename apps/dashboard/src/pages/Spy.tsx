import { useState, type FormEvent } from 'react'
import { Card, ErrorText, PageHeader } from '../components/ui'
import { api } from '../lib/api'
import { POLL, usePoll } from '../lib/hooks'
import type { SpyAd, SpyEnqueueResult, SpyFlowDetail, SpyProbe } from '../lib/types'
import { adLibraryUrl, BRANCHES, branchLabel, canDownloadFlow, formatPhone, parseLinks, PROBES_PER_DAY, probeStatusLabel, rowTitle, SENDABLE, STATUS_LABEL, summarize, VIA_LABEL } from './Spy.logic'

// As sondas são automáticas; os controles manuais legados permanecem desabilitados.
const MANUAL_PROBE_CONTROLS_ENABLED = false

export function Spy() {
  const ads = usePoll(() => api.spyAds(), POLL.list)
  const offers = usePoll(() => api.spyOffers(), POLL.page)
  const probes = usePoll(() => api.spyProbes(), POLL.page)
  const flows = usePoll(() => api.spyFlows(), POLL.page)
  const sessions = usePoll(() => api.sessions(), POLL.page)
  const autoProbe = usePoll(() => api.spyAutoProbe(), POLL.page)
  const sendable = sessions.data?.filter((s) => SENDABLE.includes(s.status)) ?? []
  const excluded = new Set(autoProbe.data?.excludedSessionIds ?? [])
  const [chip, setChip] = useState<Record<string, string>>({})
  const [branch, setBranch] = useState<Record<string, string>>({})
  const [openProbe, setOpenProbe] = useState<string>()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [last, setLast] = useState<SpyEnqueueResult>()
  const [manual, setManual] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<Record<string, { flowId: string; mediaCount: number }>>({})
  const [openFlow, setOpenFlow] = useState<string>()
  const [flowDetail, setFlowDetail] = useState<SpyFlowDetail>()
  const [flowTitle, setFlowTitle] = useState('')
  const [flowScript, setFlowScript] = useState('')
  const [importResult, setImportResult] = useState('')
  const links = parseLinks(text)
  const rows = ads.data?.filter((a) => a.status !== 'expandido') ?? []
  const searches = ads.data?.filter((a) => a.status === 'expandido') ?? []
  const stats = summarize(ads.data ?? [])

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try { await action(); ads.reload(); offers.reload(); probes.reload(); flows.reload() }
    catch (err) { setError(err) }
    finally { setBusy(false) }
  }
  async function downloadFlow(offerId: string) {
    setError(undefined)
    try {
      const { blob, filename } = await api.spyFlowZip(offerId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err)
    }
  }
  async function copyToCrm(offerId: string) {
    setError(undefined)
    setBusy(true)
    try {
      const result = await api.spyCopyToCrm(offerId)
      setCopied((current) => ({ ...current, [offerId]: { flowId: result.flowId, mediaCount: result.mediaCount } }))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  async function editFlow(id: string) {
    setError(undefined)
    try {
      if (openFlow === id) { setOpenFlow(undefined); setFlowDetail(undefined); return }
      const detail = await api.spyFlow(id)
      setFlowDetail(detail)
      setFlowTitle(detail.title)
      setFlowScript(detail.script)
      setOpenFlow(id)
    } catch (err) { setError(err) }
  }
  async function saveFlow() {
    if (!flowDetail) return
    await mutate(async () => {
      await api.spyEditFlow(flowDetail.id, flowTitle, flowScript)
      setFlowDetail({ ...flowDetail, title: flowTitle, script: flowScript })
    })
  }
  async function importFlow(file?: File) {
    if (!file) return
    setBusy(true)
    setError(undefined)
    setImportResult('')
    try {
      const result = await api.spyImportFlow(file)
      setImportResult(`${result.title}: ${result.conversations} conversa(s) e ${result.mediaAdded} mídia(s) importadas`)
      flows.reload(); offers.reload()
      await editFlow(result.id)
    } catch (err) { setError(err) }
    finally { setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    await mutate(async () => {
      setLast(await api.spyEnqueue(links.slice(0, 50)))
      setText('')
    })
  }

  async function setAutoChip(sessionId: string, use: boolean) {
    setBusy(true)
    setError(undefined)
    try {
      const next = new Set(autoProbe.data?.excludedSessionIds ?? [])
      if (use) next.delete(sessionId)
      else next.add(sessionId)
      await api.spySetAutoProbe([...next])
      autoProbe.reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
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
    <section className="panel stack" data-testid="spy-auto-probe">
      <h2>Chips que não devem ser usados</h2>
      <p className="muted">Todos os chips disponíveis podem sondar automaticamente. Marque somente os chips que você quer bloquear. Se nada estiver marcado, todos podem ser usados.</p>
      <div className="row">
        {sessions.data?.map((s) => <label key={s.id} className="row">
          <input type="checkbox" checked={excluded.has(s.id)} disabled={busy || !autoProbe.data}
            onChange={(e) => void setAutoChip(s.id, !e.target.checked)} />
          Não usar {s.name} ({SENDABLE.includes(s.status) ? 'disponível' : s.status})
        </label>)}
        {sessions.data?.length === 0 && <span className="muted">Nenhum chip cadastrado.</span>}
      </div>
    </section>
    <ErrorText error={error ?? ads.error ?? offers.error ?? probes.error ?? flows.error ?? autoProbe.error} />

    <div className="cards">
      <Card testId="spy-total" title="Anúncios" value={stats.total} />
      <Card testId="spy-pending" title="Na fila" value={stats.pending} />
      <Card testId="spy-found" title="Com número" value={stats.found} />
      <Card testId="spy-missing" title="Sem número" value={stats.missing} />
    </div>

    <section className="panel stack" data-testid="spy-saved-flows">
      <div className="spy-flow-heading">
        <div><h2>Fluxos salvos</h2><p className="muted">Conversas e mídias capturadas ficam guardadas. Importe um ZIP do Espião ou abra um fluxo para ajustar o roteiro usado pela IA.</p></div>
        <label className="button secondary btn-sm spy-import">
          Importar fluxo (ZIP)
          <input type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => { void importFlow(e.target.files?.[0]); e.currentTarget.value = '' }} />
        </label>
      </div>
      {importResult && <p className="status">✓ {importResult}</p>}
      <div className="table-wrap"><table className="spy-table">
        <thead><tr><th>Fluxo</th><th>Origem</th><th>Conteúdo</th><th>Ações</th></tr></thead>
        <tbody>
          {flows.data?.map((flow) => <tr key={flow.id}>
            <td><strong>{flow.title}</strong><span className="hint">{/^\d+$/.test(flow.phone) ? formatPhone(flow.phone) : 'sem número vinculado'} · atualizado {new Date(flow.updatedAt).toLocaleString('pt-BR')}</span></td>
            <td><span className="tag">{flow.source === 'imported' ? 'Importado' : 'Capturado'}</span></td>
            <td>{flow.branchCount} conversa(s) · {flow.mediaCount} mídia(s)</td>
            <td className="cell-actions"><div className="row">
              <button type="button" className="secondary btn-sm" onClick={() => void editFlow(flow.id)}>{openFlow === flow.id ? 'Fechar' : 'Editar roteiro capturado'}</button>
              <button type="button" className="secondary btn-sm" onClick={() => downloadFlow(flow.id)}>Baixar ZIP completo</button>
              <button type="button" disabled={busy} onClick={() => copyToCrm(flow.id)}>Criar fluxo editavel no CRM</button>
              {copied[flow.id] && <a className="button btn-sm" href={`#/crm/${encodeURIComponent(copied[flow.id]!.flowId)}`}>Abrir editor do CRM ({copied[flow.id]!.mediaCount} midias)</a>}
            </div></td>
          </tr>)}
          {flows.data?.length === 0 && <tr><td colSpan={4}>Nenhum fluxo salvo ainda.</td></tr>}
        </tbody>
      </table></div>
      {openFlow && flowDetail && <div className="spy-flow-editor">
        <h3>Editar fluxo</h3>
        <label>Título<input value={flowTitle} maxLength={120} onChange={(e) => setFlowTitle(e.target.value)} /></label>
        <label>Roteiro editável<textarea rows={14} value={flowScript} onChange={(e) => setFlowScript(e.target.value)} /></label>
        <div className="actions"><button type="button" disabled={busy || !flowTitle.trim() || !flowScript.trim()} onClick={() => void saveFlow()}>Salvar alterações</button></div>
        <div className="spy-flow-assets">
          <div><h3>Conversas originais</h3>{flowDetail.conversations.map((conversation) => <details key={conversation.fileName}><summary>{conversation.fileName}</summary><pre>{conversation.content}</pre></details>)}</div>
          <div><h3>Mídias</h3>{flowDetail.media.length === 0 ? <p className="muted">Nenhuma mídia salva.</p> : <ul>{flowDetail.media.map((media) => <li key={media.id}>{media.fileName ?? media.kind} · {media.mime} · {formatBytes(media.size)}</li>)}</ul>}</div>
        </div>
      </div>}
    </section>

    {MANUAL_PROBE_CONTROLS_ENABLED && <section className="panel stack">
      <h2>Ofertas (por número)</h2>
      <p className="muted">Sondar: o chip escolhido conversa com a oferta como um lead (IA), com atraso humano, até o preço/checkout, sem pagar e sem passar dados reais. Se a oferta ficar 2 horas sem responder, a sonda encerra. O fluxo pode ser criado no CRM a qualquer momento. Até {PROBES_PER_DAY} sondas novas por chip por dia.</p>
      <div className="table-wrap"><table className="spy-table" data-testid="spy-offers">
        <thead><tr><th>WhatsApp</th><th>Página</th><th>Anúncios</th><th>Sondar com</th></tr></thead>
        <tbody>
          {offers.data?.map((o) => {
            const active = probes.data?.filter((p) => p.offerId === o.id && p.status === 'ativa') ?? []
            const free = BRANCHES.filter((b) => !active.some((p) => p.branch === b.id))
            const pick = branch[o.id] && free.some((b) => b.id === branch[o.id]) ? branch[o.id]! : free[0]?.id
            return <tr key={o.id}>
              <td><a href={`https://wa.me/${o.phone}`} target="_blank" rel="noreferrer">{formatPhone(o.phone)}</a></td>
              <td>{o.pageName ?? '—'}</td>
              <td>{o.ads}</td>
              <td className="cell-actions">
                {active.length > 0 && <span className="tag">{active.map((p) => branchLabel(p.branch)).join(' · ')}</span>}
                {pick && <div className="row">
                  <select aria-label="Chip da sonda" value={chip[o.id] ?? ''} onChange={(e) => setChip((c) => ({ ...c, [o.id]: e.target.value }))}>
                    <option value="">Escolha o chip</option>
                    {sendable.filter((s) => !active.some((p) => p.sessionId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
                  </select>
                  <select aria-label="Caminho da sonda" value={pick} onChange={(e) => setBranch((b) => ({ ...b, [o.id]: e.target.value }))}>
                    {free.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                  </select>
                  <button type="button" className="secondary btn-sm" disabled={busy || !chip[o.id]} onClick={() => mutate(() => api.spyStartProbe(o.id, chip[o.id]!, pick))}>Sondar</button>
                </div>}
                {canDownloadFlow(o.status) && <div className="row">
                  <button type="button" className="secondary btn-sm" data-testid="spy-download-flow" onClick={() => downloadFlow(o.id)}>Baixar fluxo (ZIP)</button>
                  <button type="button" data-testid="spy-copy-crm" disabled={busy} onClick={() => copyToCrm(o.id)}>Criar fluxo editavel no CRM</button>
                  {copied[o.id] && <a className="button btn-sm" href={`#/crm/${encodeURIComponent(copied[o.id]!.flowId)}`}>Abrir editor ({copied[o.id]!.mediaCount} midias)</a>}
                </div>}
              </td>
            </tr>
          })}
          {offers.data?.length === 0 && <tr><td colSpan={4}>Nenhuma oferta ainda.</td></tr>}
        </tbody>
      </table></div>
    </section>}

    <section className="panel stack" data-testid="spy-probes">
      <h2>Sondas</h2>
      {probes.data?.length === 0 && <p className="muted">Nenhuma sonda iniciada. Quando uma oferta for encontrada, o sistema escolhe automaticamente um chip permitido e disponível.</p>}
      {probes.data?.map((p) => <ProbeCard key={p.id} probe={p} busy={busy} open={openProbe === p.id} crm={copied[p.offerId]}
        onToggle={() => setOpenProbe((id) => (id === p.id ? undefined : p.id))}
        onCopy={() => copyToCrm(p.offerId)}
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

function ProbeCard({ probe, busy, open, crm, onToggle, onCopy, onStop }: {
  probe: SpyProbe
  busy: boolean
  open: boolean
  crm?: { flowId: string; mediaCount: number }
  onToggle: () => void
  onCopy: () => void
  onStop: () => void
}) {
  const s = probe.summary
  const offer = probe.offerTitle ?? probe.pageName ?? formatPhone(probe.phone.replace(/^\+/, ''))
  const stage = s.etapa ?? (s.checkout?.length ? 'Checkout encontrado' : s.preco ? 'Preco encontrado' : probe.turns > 1 ? 'Conversando com a oferta' : probe.turns === 1 ? 'Aguardando primeira resposta' : 'Preparando abertura')
  const lastActivity = probe.lastInboundAt ?? probe.lastOutboundAt ?? probe.startedAt
  return <article className="spy-probe" data-testid="spy-probe">
    <header>
      <strong>Oferta: {offer}</strong>
      <span className="tag">{probeStatusLabel(probe, Date.now())}</span>
      <span className="hint">{branchLabel(probe.branch)} · {probe.sessionName ?? 'chip'} · {probe.turns}/{probe.maxTurns} respostas · desde {new Date(probe.startedAt).toLocaleString('pt-BR')}</span>
    </header>
    <dl className="spy-summary">
      <dt>Etapa atual</dt><dd><strong>{stage}</strong></dd>
      <dt>Chip usado</dt><dd>{probe.sessionName ?? 'chip nao identificado'}</dd>
      <dt>Ultima atividade</dt><dd>{new Date(lastActivity).toLocaleString('pt-BR')} · {elapsed(lastActivity)}</dd>
      {s.preco && <><dt>Preço</dt><dd>{s.preco}</dd></>}
      {s.checkout && s.checkout.length > 0 && <><dt>Checkout</dt><dd>{s.checkout.map((c) => /^https?:\/\//.test(c) ? <a key={c} href={c} target="_blank" rel="noreferrer">{c}</a> : <span key={c}>{c}</span>)}</dd></>}
      {s.links && s.links.length > 0 && <><dt>Links</dt><dd>{s.links.map((l) => <a key={l} href={l} target="_blank" rel="noreferrer">{l}</a>)}</dd></>}
      {s.humano && <><dt>Atendimento</dt><dd>parece humano</dd></>}
      {(probe.endedReason ?? s.notas) && <><dt>Nota</dt><dd>{probe.endedReason ?? s.notas}</dd></>}
    </dl>
    <div className="actions">
      <button type="button" className="secondary btn-sm" onClick={onToggle}>{open ? 'Esconder conversa' : 'Ver conversa'}</button>
      <button type="button" disabled={busy} onClick={onCopy}>Criar fluxo editavel no CRM</button>
      {crm && <a className="button btn-sm" href={`#/crm/${encodeURIComponent(crm.flowId)}`}>Abrir editor do CRM ({crm.mediaCount} midias)</a>}
      {probe.status === 'ativa' && <button type="button" className="secondary btn-sm" disabled={busy} onClick={onStop}>Parar</button>}
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

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function elapsed(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `ha ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `ha ${hours}h${minutes % 60 ? ` ${minutes % 60}min` : ''}`
}
