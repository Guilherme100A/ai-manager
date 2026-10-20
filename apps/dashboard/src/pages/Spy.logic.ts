import type { SessionState, SpyAd, SpyAdStatus, SpyFoundVia, SpyProbe } from '../lib/types'

export const STATUS_LABEL: Record<SpyAdStatus, string> = {
  na_fila: 'Na fila',
  lendo: 'Procurando…',
  achado: 'Número achado',
  sem_numero: 'Sem número',
  erro: 'Erro',
  expandido: 'Busca lida',
}

export const VIA_LABEL: Record<SpyFoundVia, string> = {
  link: 'link do anúncio',
  texto: 'texto do anúncio',
  post: 'botão do post',
  pagina: 'página Sobre',
  manual: 'colado à mão',
}

/** Um link por linha (também aceita links separados por espaço ou vírgula); sem repetidos. */
export function parseLinks(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((l) => l.trim()).filter(Boolean))]
}

/** +55 84 92002-2034 para leitura; o wa.me usa só os dígitos. */
export function formatPhone(phone: string): string {
  const m = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/)
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${phone}`
}

export function adLibraryUrl(ad: Pick<SpyAd, 'adArchiveId' | 'inputUrl'>): string {
  return ad.adArchiveId ? `https://www.facebook.com/ads/library/?id=${ad.adArchiveId}` : ad.inputUrl
}

/** Título da linha antes (ou sem) o nome da página: o tipo de link colado. */
export function rowTitle(ad: Pick<SpyAd, 'status' | 'inputUrl' | 'adArchiveId'>): string {
  if (ad.status === 'na_fila' || ad.status === 'lendo') return ad.adArchiveId ? 'Lendo anúncio…' : 'Na fila…'
  if (/wa\.me|whatsapp\.com/i.test(ad.inputUrl)) return 'Link do WhatsApp'
  if (ad.adArchiveId) return 'Anúncio'
  return 'Post da página'
}

export function summarize(ads: SpyAd[]) {
  const rows = ads.filter((a) => a.status !== 'expandido')
  return {
    total: rows.length,
    pending: rows.filter((a) => a.status === 'na_fila' || a.status === 'lendo').length,
    found: rows.filter((a) => a.status === 'achado').length,
    missing: rows.filter((a) => a.status === 'sem_numero' || a.status === 'erro').length,
  }
}

/** Estados de chip que podem enviar (mesma regra do servidor). */
export const SENDABLE: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED']
export const PROBES_PER_DAY = 5

export function probeStatusLabel(p: Pick<SpyProbe, 'status' | 'listenUntil' | 'replyDueAt'>, now: number): string {
  if (p.status === 'ativa') return p.replyDueAt && Date.parse(p.replyDueAt) > now ? 'Vai responder…' : p.replyDueAt ? 'Respondendo…' : 'Esperando a oferta'
  if (p.listenUntil && Date.parse(p.listenUntil) > now) return 'Concluída · ouvindo remarketing'
  return p.status === 'concluida' ? 'Concluída' : p.status === 'parada' ? 'Parada' : 'Erro'
}

/** Caminhos da sonda (mesma lista do servidor). */
export const BRANCHES = [
  { id: 'principal', label: 'Principal (até o checkout)' },
  { id: 'objecao', label: 'Objeção ("tá caro")' },
  { id: 'sumiu', label: 'Sumiu (remarketing)' },
] as const

export function branchLabel(id: string): string {
  return id === 'objecao' ? 'Objeção' : id === 'sumiu' ? 'Sumiu' : 'Principal'
}

/** O fluxo já tem conteúdo para baixar (ZIP) quando uma sonda começou (sondando) ou terminou (completa). */
export function canDownloadFlow(offerStatus: string): boolean {
  return offerStatus === 'sondando' || offerStatus === 'completa'
}
