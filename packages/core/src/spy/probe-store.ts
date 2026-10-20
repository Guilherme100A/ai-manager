// Sondas do Espião no banco: criação com as travas (chip, limite diário, consentimento), estado da conversa e histórico.
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import { auditLogs, contacts, messages, sessions, spyOffers, spyProbes, type Database, type SpyBranch, type SpyProbeSummary } from '@wsm/db'
import { SENDABLE_STATES } from '../session/states'
import type { ProbeTurn } from './probe-model'

export type SpyProbeRow = typeof spyProbes.$inferSelect

export class SpyProbeError extends Error {
  constructor(readonly code: 'OFFER_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'SESSION_NOT_READY' | 'PROBE_ACTIVE' | 'DAILY_LIMIT' | 'OPT_OUT' | 'OWN_NUMBER', message: string) {
    super(message)
    this.name = 'SpyProbeError'
  }
}

/** De onde vem o "consentimento" de uma sonda: o próprio anúncio público convida a chamar no WhatsApp. */
export const SPY_CONSENT_SOURCE = 'spy_anuncio'
/** Sondas novas por chip por dia (ritmo baixo para não queimar o chip). */
export const SPY_PROBES_PER_DAY = 5
/** Depois de encerrar, a sonda continua ouvindo (sem responder) para gravar o remarketing. */
export const SPY_LISTEN_DAYS = 7

const DAY = 86_400_000

export interface SpyProbeView extends SpyProbeRow {
  sessionName: string | null
  pageName: string | null
}

export class SpyProbeStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  /** Começa uma sonda: valida chip e limites, registra o contato (origem: anúncio) e deixa a abertura pendente. */
  /** `startInMs`: atrasa a abertura (várias sondas na mesma oferta não chegam todas juntas). */
  async create(input: { offerId: string; sessionId: string; createdBy: string; branch?: SpyBranch; maxTurns?: number; startInMs?: number }): Promise<SpyProbeRow> {
    const [offer] = await this.db.select().from(spyOffers).where(eq(spyOffers.id, input.offerId))
    if (!offer) throw new SpyProbeError('OFFER_NOT_FOUND', 'Oferta não encontrada')
    const [session] = await this.db.select().from(sessions).where(eq(sessions.id, input.sessionId))
    if (!session) throw new SpyProbeError('SESSION_NOT_FOUND', 'Chip não encontrado')
    if (!SENDABLE_STATES.includes(session.status)) throw new SpyProbeError('SESSION_NOT_READY', `O chip ${session.name} está ${session.status}; use um chip conectado`)
    const phone = `+${offer.phone}`
    const managed = await this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.phone, phone)).limit(1)
    if (managed.length > 0) throw new SpyProbeError('OWN_NUMBER', 'Esse número é de um chip seu')
    const since = new Date(this.now() - DAY)
    const [count] = await this.db.select({ n: sql<number>`count(*)::int` }).from(spyProbes)
      .where(and(eq(spyProbes.sessionId, session.id), gte(spyProbes.startedAt, since)))
    const n = count?.n ?? 0
    if (n >= SPY_PROBES_PER_DAY) throw new SpyProbeError('DAILY_LIMIT', `O chip ${session.name} já começou ${n} sondas nas últimas 24 h (limite ${SPY_PROBES_PER_DAY})`)

    const [contact] = await this.db.select().from(contacts).where(eq(contacts.phone, phone))
    if (contact?.optOut) throw new SpyProbeError('OPT_OUT', 'Esse número pediu para não receber mensagens')
    if (!contact) {
      await this.db.insert(contacts).values({ phone, name: offer.pageName, consent: true, consentAt: new Date(this.now()), consentSource: SPY_CONSENT_SOURCE })
    } else if (!contact.consent) {
      await this.db.update(contacts).set({ consent: true, consentAt: new Date(this.now()), consentSource: SPY_CONSENT_SOURCE }).where(eq(contacts.id, contact.id))
    }
    let row: SpyProbeRow | undefined
    try {
      [row] = await this.db.insert(spyProbes).values({
        offerId: offer.id, sessionId: session.id, phone, createdBy: input.createdBy, maxTurns: input.maxTurns ?? 12, branch: input.branch ?? 'principal',
        replyDueAt: new Date(this.now() + Math.max(0, input.startInMs ?? 0)), startedAt: new Date(this.now()), updatedAt: new Date(this.now()),
      }).returning()
    } catch (err) {
      const detail = String((err as { cause?: unknown }).cause ?? err)
      if (/spy_probes_active_branch_idx/.test(detail)) throw new SpyProbeError('PROBE_ACTIVE', `Já existe uma sonda "${input.branch ?? 'principal'}" ativa nessa oferta`)
      if (/spy_probes_active_session_idx/.test(detail)) throw new SpyProbeError('PROBE_ACTIVE', 'Esse chip já está sondando essa oferta; use outro chip para outra ramificação')
      throw err
    }
    await this.db.update(spyOffers).set({ status: 'sondando', updatedAt: new Date(this.now()) }).where(eq(spyOffers.id, offer.id))
    await this.db.insert(auditLogs).values({ actor: input.createdBy, action: 'spy.probe.start', targetType: 'spy_probe', targetId: row!.id, detail: { offerId: offer.id, sessionId: session.id, consentSource: SPY_CONSENT_SOURCE } })
    return row!
  }

  async list(limit = 100): Promise<SpyProbeView[]> {
    const rows = await this.db.select({ probe: spyProbes, sessionName: sessions.name, pageName: spyOffers.pageName }).from(spyProbes)
      .leftJoin(sessions, eq(sessions.id, spyProbes.sessionId)).leftJoin(spyOffers, eq(spyOffers.id, spyProbes.offerId))
      .orderBy(desc(spyProbes.startedAt)).limit(limit)
    return rows.map((r) => ({ ...r.probe, sessionName: r.sessionName, pageName: r.pageName }))
  }

  get(id: string) { return this.db.select().from(spyProbes).where(eq(spyProbes.id, id)).then((r) => r[0]) }
  active() { return this.db.select().from(spyProbes).where(eq(spyProbes.status, 'ativa')) }

  /** Sonda que ainda escuta esse número nesse chip: ativa, ou encerrada dentro da janela do remarketing. */
  async listening(sessionId: string, phone: string): Promise<SpyProbeRow | undefined> {
    const [row] = await this.db.select().from(spyProbes).where(and(eq(spyProbes.sessionId, sessionId), eq(spyProbes.phone, phone),
      or(eq(spyProbes.status, 'ativa'), and(isNotNull(spyProbes.listenUntil), gt(spyProbes.listenUntil, new Date(this.now())))))).orderBy(desc(spyProbes.startedAt)).limit(1)
    return row
  }

  /** Horário da mensagem mais recente da oferta desde o começo da sonda (texto, áudio, imagem…). */
  async latestInbound(probe: Pick<SpyProbeRow, 'sessionId' | 'phone' | 'startedAt'>): Promise<Date | undefined> {
    const [row] = await this.db.select({ at: sql<Date>`max(${messages.createdAt})` }).from(messages)
      .where(and(eq(messages.sessionId, probe.sessionId), eq(messages.phone, probe.phone), eq(messages.direction, 'inbound'), gte(messages.createdAt, probe.startedAt)))
    return row?.at ? new Date(row.at) : undefined
  }

  /** Conversa da sonda (as duas pontas), no formato da IA. */
  async history(probe: Pick<SpyProbeRow, 'sessionId' | 'phone' | 'startedAt'>, until?: Date): Promise<Array<ProbeTurn & { at: Date }>> {
    const rows = await this.db.select({ direction: messages.direction, content: messages.content, at: messages.createdAt, status: messages.status }).from(messages)
      .where(and(eq(messages.sessionId, probe.sessionId), eq(messages.phone, probe.phone), gte(messages.createdAt, probe.startedAt), until ? lte(messages.createdAt, until) : undefined))
      .orderBy(asc(messages.createdAt)).limit(400)
    return rows.filter((r) => r.direction === 'inbound' || !['failed', 'cancelled'].includes(r.status))
      .map((r) => ({ de: r.direction === 'inbound' ? 'oferta' as const : 'eu' as const, texto: contentText(r.content), at: r.at }))
  }

  /** Mensagem nova da oferta: responde depois de `delayMs` (reinicia a cada mensagem, para juntar as que vêm em sequência). */
  async inboundSeen(id: string, at: Date, delayMs: number) {
    await this.db.update(spyProbes).set({ lastInboundAt: at, replyDueAt: new Date(this.now() + delayMs), updatedAt: new Date(this.now()) }).where(eq(spyProbes.id, id))
  }

  /** Não deu para responder agora (chip fora, limite, erro passageiro): tenta de novo em `ms`. */
  async postpone(id: string, ms: number) {
    await this.db.update(spyProbes).set({ replyDueAt: new Date(this.now() + ms), updatedAt: new Date(this.now()) }).where(eq(spyProbes.id, id))
  }

  due() {
    return this.db.select().from(spyProbes).where(and(eq(spyProbes.status, 'ativa'), isNotNull(spyProbes.replyDueAt), lte(spyProbes.replyDueAt, new Date(this.now()))))
  }

  async replied(id: string, patch: { turns?: number; summary?: SpyProbeSummary; sentAt?: Date }) {
    await this.db.update(spyProbes).set({
      replyDueAt: null, updatedAt: new Date(this.now()),
      ...(patch.turns !== undefined ? { turns: patch.turns } : {}),
      ...(patch.summary ? { summary: patch.summary } : {}),
      ...(patch.sentAt ? { lastOutboundAt: patch.sentAt } : {}),
    }).where(eq(spyProbes.id, id))
  }

  /** Encerra (ou para) a sonda; segue ouvindo o remarketing por SPY_LISTEN_DAYS, menos quando parada à mão ou por opt-out. */
  async end(id: string, status: 'concluida' | 'parada' | 'erro', reason: string, opts: { listen?: boolean; summary?: SpyProbeSummary } = {}) {
    const listen = opts.listen ?? status === 'concluida'
    const [row] = await this.db.update(spyProbes).set({
      status, endedReason: reason.slice(0, 500), replyDueAt: null, endedAt: new Date(this.now()), updatedAt: new Date(this.now()),
      listenUntil: listen ? new Date(this.now() + SPY_LISTEN_DAYS * DAY) : null,
      ...(opts.summary ? { summary: opts.summary } : {}),
    }).where(and(eq(spyProbes.id, id), inArray(spyProbes.status, ['ativa', 'concluida']))).returning()
    if (row) await this.db.update(spyOffers).set({ status: status === 'concluida' ? 'completa' : 'nova', updatedAt: new Date(this.now()) }).where(eq(spyOffers.id, row.offerId))
    return row
  }
}

const MEDIA_LABEL: Record<string, string> = {
  audioMessage: '[áudio]', imageMessage: '[imagem]', videoMessage: '[vídeo]', documentMessage: '[documento]',
  stickerMessage: '[figurinha]', ptvMessage: '[vídeo]', locationMessage: '[localização]', contactMessage: '[contato]',
}

/** Texto de uma linha de `messages.content` (recebida `{type,text}` ou enviada `{text}`/mídia). */
export function contentText(content: unknown): string {
  const c = (content ?? {}) as { text?: unknown; caption?: unknown; type?: unknown; image?: unknown; audio?: unknown; document?: unknown; video?: unknown }
  const label = typeof c.type === 'string' ? MEDIA_LABEL[c.type] : undefined
  const text = typeof c.text === 'string' ? c.text : typeof c.caption === 'string' ? c.caption : undefined
  if (label && text) return `${label} ${text}`
  if (text) return text
  if (label) return label
  if (c.image) return '[imagem]'
  if (c.audio) return '[áudio]'
  if (c.video) return '[vídeo]'
  if (c.document) return '[documento]'
  return '[mensagem]'
}
