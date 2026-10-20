// Monta o fluxo capturado de uma oferta (as ramificações, a conversa das duas pontas e a lista de mídias) e o
// transforma em markdown para o pacote (ZIP) e em roteiro para copiar pro CRM. Os bytes das mídias ficam de fora
// aqui (a API os busca na hora de montar o ZIP); este módulo cuida só do texto e dos metadados.
import { asc, eq } from 'drizzle-orm'
import { spyMedia, spyOffers, spyProbes, type Database, type SpyProbeSummary } from '@wsm/db'
import { SpyProbeStore } from './probe-store'

export interface SpyFlowTurn { de: 'eu' | 'oferta'; texto: string; at: Date }
export interface SpyFlowBranch {
  probeId: string
  branch: string
  status: string
  endedReason: string | null
  summary: SpyProbeSummary
  turns: SpyFlowTurn[]
}
export interface SpyFlowMediaRef {
  id: string
  probeId: string | null
  branch: string | null
  kind: string
  mime: string
  fileName: string | null
  size: number
}
export interface SpyFlow {
  offerId: string
  phone: string
  pageName: string | null
  status: string
  branches: SpyFlowBranch[]
  media: SpyFlowMediaRef[]
  generatedAt: Date
}

const BRANCH_LABEL: Record<string, string> = {
  principal: 'Principal (até o checkout)',
  objecao: 'Objeção ("tá caro")',
  sumiu: 'Sumiu (remarketing)',
}
export const branchLabel = (branch: string): string => BRANCH_LABEL[branch] ?? branch

const STATUS_LABEL: Record<string, string> = {
  ativa: 'em andamento', concluida: 'concluída', parada: 'parada', erro: 'erro',
}

/** Monta o fluxo da oferta a partir do banco. `undefined` se a oferta não existe. */
export async function buildSpyFlow(db: Database, offerId: string, now: () => number = Date.now): Promise<SpyFlow | undefined> {
  const [offer] = await db.select().from(spyOffers).where(eq(spyOffers.id, offerId))
  if (!offer) return undefined
  const store = new SpyProbeStore(db)
  const probes = await db.select().from(spyProbes).where(eq(spyProbes.offerId, offerId)).orderBy(asc(spyProbes.startedAt))
  const branches: SpyFlowBranch[] = []
  for (const p of probes) {
    branches.push({ probeId: p.id, branch: p.branch, status: p.status, endedReason: p.endedReason, summary: p.summary, turns: await store.history(p) })
  }
  const media = await db.select({
    id: spyMedia.id, probeId: spyMedia.probeId, branch: spyMedia.branch, kind: spyMedia.kind, mime: spyMedia.mime, fileName: spyMedia.fileName, size: spyMedia.size,
  }).from(spyMedia).where(eq(spyMedia.offerId, offerId)).orderBy(asc(spyMedia.createdAt))
  return { offerId, phone: offer.phone, pageName: offer.pageName, status: offer.status, branches, media, generatedAt: new Date(now()) }
}

/** Extensão de arquivo pelo mime (imagem/PDF/áudio/vídeo). */
export function mediaExtension(mime: string): string {
  const m = (mime || '').toLowerCase()
  if (m.includes('pdf')) return '.pdf'
  if (m.includes('video')) return m.includes('webm') ? '.webm' : '.mp4'
  if (m.includes('audio')) {
    if (m.includes('ogg') || m.includes('opus')) return '.ogg'
    if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return '.m4a'
    if (m.includes('wav')) return '.wav'
    return '.mp3'
  }
  if (m.includes('png')) return '.png'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  return '.jpg'
}

/** Caminho do arquivo da mídia dentro do ZIP (agrupado por ramificação). */
export function mediaZipPath(ref: SpyFlowMediaRef, index: number): string {
  const dir = `midias/${ref.branch ?? 'oferta'}`
  if (ref.fileName && /\.[a-z0-9]{2,4}$/i.test(ref.fileName)) return `${dir}/${String(index).padStart(2, '0')}-${sanitize(ref.fileName)}`
  return `${dir}/${String(index).padStart(2, '0')}-${ref.kind}${mediaExtension(ref.mime)}`
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 60)
}

/** resumo.md: a oferta e, por ramificação, etapa/preço/checkout/links/opções/notas e a contagem de mensagens. */
export function renderFlowSummary(flow: SpyFlow): string {
  const out: string[] = [`# ${flow.pageName ?? 'Oferta'} — wa.me/${flow.phone}`, '']
  out.push(`Gerado em ${flow.generatedAt.toISOString()} · ${flow.branches.length} ramificação(ões) · ${flow.media.length} mídia(s)`, '')
  for (const b of flow.branches) {
    const s = b.summary ?? {}
    const daOferta = b.turns.filter((t) => t.de === 'oferta').length
    const daSonda = b.turns.filter((t) => t.de === 'eu').length
    out.push(`## ${branchLabel(b.branch)} — ${STATUS_LABEL[b.status] ?? b.status}`)
    out.push(`- Etapa: ${s.etapa ?? '—'}`)
    out.push(`- Preço: ${s.preco ?? '—'}`)
    out.push(`- Checkout: ${s.checkout?.length ? s.checkout.join(', ') : '—'}`)
    out.push(`- Links: ${s.links?.length ? s.links.join(', ') : '—'}`)
    out.push(`- Opções vistas: ${s.opcoes?.length ? s.opcoes.join(' | ') : '—'}`)
    if (s.notas) out.push(`- Notas: ${s.notas}`)
    if (b.endedReason) out.push(`- Encerramento: ${b.endedReason}`)
    out.push(`- Mensagens: ${daOferta} da oferta, ${daSonda} da sonda`, '')
  }
  return out.join('\n')
}

/** conversa-<ramificação>.md: a conversa das duas pontas, com as transcrições já embutidas no texto. */
export function renderBranchConversation(flow: SpyFlow, b: SpyFlowBranch): string {
  const out: string[] = [`# ${branchLabel(b.branch)} — ${flow.pageName ?? 'Oferta'} (wa.me/${flow.phone})`, '']
  for (const t of b.turns) {
    const quem = t.de === 'oferta' ? 'OFERTA' : 'SONDA'
    out.push(`**${quem}** · ${t.at.toISOString()}`)
    out.push(t.texto, '')
  }
  return out.join('\n')
}

/** Roteiro do funil em texto corrido — base para "copiar pro CRM" e para quem quiser ler rápido. */
export function renderFlowPlaybook(flow: SpyFlow): string {
  const out: string[] = [`Funil de ${flow.pageName ?? 'oferta'} (wa.me/${flow.phone})`, '']
  for (const b of flow.branches) {
    const s = b.summary ?? {}
    out.push(`[${branchLabel(b.branch)}]`)
    if (s.etapa) out.push(`Etapa final: ${s.etapa}`)
    if (s.preco) out.push(`Preço: ${s.preco}`)
    if (s.checkout?.length) out.push(`Checkout/pagamento: ${s.checkout.join(', ')}`)
    if (s.opcoes?.length) out.push(`Opções oferecidas: ${s.opcoes.join(' | ')}`)
    out.push('Conversa:')
    for (const t of b.turns) out.push(`  ${t.de === 'oferta' ? 'Empresa' : 'Lead'}: ${t.texto}`)
    out.push('')
  }
  return out.join('\n')
}
