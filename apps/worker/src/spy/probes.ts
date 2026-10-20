// Sondas do Espião: o chip conversa com a oferta como um lead (IA), com atraso humano e "digitando…".
// O estado fica no banco (spy_probes), então um restart do worker continua de onde parou. As mensagens da oferta
// são lidas da tabela messages (inclui áudio/imagem, que não têm texto e não passam pelo gancho das conversas).
import {
  BRANCH_STRATEGY, phoneToUserJid, ProbeAiDisabledError, SENDABLE_STATES, SendRejectedError,
  type MessageQueue, type ProbeModel, type SendPipeline, type SessionView, type SpyProbeRow, type SpyProbeStore,
} from '@wsm/core'
import type { SpyProbeSummary } from '@wsm/db'

export interface SpyProbeOptions {
  store: SpyProbeStore
  model: ProbeModel
  manager: { get(id: string): Promise<SessionView>; getTransport(id: string): { sendTyping?(to: string, on: boolean): Promise<void> } | undefined }
  pipeline: Pick<SendPipeline, 'send'>
  messages: Pick<MessageQueue, 'get'>
  /** Contato ainda pode receber (sem opt-out). */
  allowed(phone: string): Promise<boolean>
  offerContext(offerId: string): Promise<{ pagina?: string; anuncio?: string }>
  logger: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }
  now?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Worker sob pressão: não abre rodadas. */
  paused?: () => boolean
}

const SECOND = 1_000
const MINUTE = 60 * SECOND
const TICK = 15 * SECOND
/** Atraso depois da última mensagem da oferta: junta as mensagens seguidas do robô e parece gente. */
const REPLY_DELAY = { min: 40 * SECOND, max: 150 * SECOND }
const SILENCE_END = 24 * 60 * MINUTE
const PART_SEND_TIMEOUT = 90 * SECOND

const OPENERS = {
  pt: ['Oi! Vi o anúncio de vocês e fiquei interessada, como funciona?', 'Olá, vi o anúncio e queria saber mais 😊', 'Oi, tudo bem? Vim pelo anúncio, queria mais informações'],
  es: ['Hola! Vi el anuncio y me interesa, ¿cómo funciona?', 'Hola, quiero más información 😊', 'Hola, ¿qué tal? Vengo del anuncio, ¿me das más info?'],
}

/** Espanhol pelo texto do anúncio (as ofertas do México); senão português. */
export function openerLanguage(adText: string | undefined): 'pt' | 'es' {
  const t = ` ${(adText ?? '').toLowerCase()} `
  const es = [' el ', ' los ', ' para ', ' con ', ' usted', ' recetas', 'ñ', ' qué ', ' cómo ', ' aquí', ' gratis ', ' tu ', ' más '].filter((w) => t.includes(w)).length
  const pt = [' você', ' não ', ' receitas', ' aqui ', ' com ', ' para ', 'ção', 'ões', ' seu ', ' sua '].filter((w) => t.includes(w)).length
  return es > pt ? 'es' : 'pt'
}

export class SpyProbeRunner {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private readonly now: () => number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: SpyProbeOptions) {
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? Math.random
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  start() {
    this.timer = setInterval(() => this.launch(), TICK)
    this.timer.unref?.()
    this.launch()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    await this.running
  }

  /** Mensagem de um número que uma sonda escuta: só a sonda cuida dela (sem sugestão de IA nem autoresposta). */
  async handlesInbound(sessionId: string, phone: string): Promise<boolean> {
    return Boolean(await this.opts.store.listening(sessionId, phone))
  }

  private launch() {
    if (this.running || this.opts.paused?.()) return
    this.running = this.tick().catch((err) => this.opts.logger.warn({ err: (err as Error).message }, 'spy-probe: rodada falhou')).finally(() => { this.running = undefined })
  }

  async tick() {
    const { store } = this.opts
    for (const probe of await store.active()) {
      const latest = await store.latestInbound(probe)
      if (latest && (!probe.lastInboundAt || latest > probe.lastInboundAt)) {
        await store.inboundSeen(probe.id, latest, REPLY_DELAY.min + Math.floor(this.random() * (REPLY_DELAY.max - REPLY_DELAY.min)))
      } else if (!probe.replyDueAt && probe.lastOutboundAt && this.now() - probe.lastOutboundAt.getTime() > SILENCE_END) {
        await store.end(probe.id, 'concluida', 'a oferta parou de responder por 24 h')
      }
    }
    for (const probe of await store.due()) await this.respond(probe)
  }

  private async respond(probe: SpyProbeRow) {
    const { store } = this.opts
    try {
      const session = await this.opts.manager.get(probe.sessionId)
      if (!SENDABLE_STATES.includes(session.status)) return store.postpone(probe.id, 10 * MINUTE)
      if (!(await this.opts.allowed(probe.phone))) return void (await store.end(probe.id, 'parada', 'o número pediu para sair (opt-out)', { listen: false }))

      const history = await store.history(probe)
      const context = await this.opts.offerContext(probe.offerId)
      if (!history.some((t) => t.de === 'eu')) {
        const options = OPENERS[openerLanguage(context.anuncio)]
        const sentAt = await this.send(probe, options[Math.floor(this.random() * options.length)]!)
        return store.replied(probe.id, { turns: 1, sentAt })
      }

      const estrategia = BRANCH_STRATEGY[probe.branch as keyof typeof BRANCH_STRATEGY]
      const decision = await this.opts.model.decide(history.map(({ de, texto }) => ({ de, texto })), {
        ...context, turnosRestantes: Math.max(0, probe.maxTurns - probe.turns), ...(estrategia ? { estrategia } : {}),
      })
      const summary = mergeSummary(probe.summary, decision, history.filter((t) => t.de === 'oferta').map((t) => t.texto))
      if (decision.acao === 'encerrar') {
        await store.end(probe.id, 'concluida', decision.motivo ?? 'funil mapeado', { summary })
        return this.opts.logger.info({ probe: probe.id, turns: probe.turns }, 'spy-probe: concluída')
      }
      if (decision.acao === 'esperar') return store.replied(probe.id, { summary })

      let sentAt: Date | undefined
      for (const text of decision.mensagens) sentAt = (await this.send(probe, text)) ?? sentAt
      const turns = probe.turns + 1
      if (turns >= probe.maxTurns) return void (await store.end(probe.id, 'concluida', `limite de ${probe.maxTurns} respostas`, { summary }))
      await store.replied(probe.id, { turns, summary, ...(sentAt ? { sentAt } : {}) })
    } catch (err) {
      if (err instanceof ProbeAiDisabledError) return void (await store.end(probe.id, 'erro', err.message, { listen: false }))
      // Limite do chip / antiban / chip caiu: tenta de novo mais tarde, sem perder a conversa.
      const wait = err instanceof SendRejectedError ? 15 * MINUTE : 5 * MINUTE
      this.opts.logger.warn({ probe: probe.id, err: (err as Error).message }, 'spy-probe: resposta adiada')
      await store.postpone(probe.id, wait)
    }
  }

  /** "Digitando…" proporcional ao texto, envia (origin spy: passa pelo antiban e conta nos limites) e espera sair. */
  private async send(probe: SpyProbeRow, text: string): Promise<Date | undefined> {
    await this.opts.manager.getTransport(probe.sessionId)?.sendTyping?.(phoneToUserJid(probe.phone), true).catch(() => undefined)
    await this.sleep(Math.min(9 * SECOND, Math.max(2 * SECOND, 1_500 + text.length * 60)) + Math.floor(this.random() * 1_500))
    const view = await this.opts.pipeline.send({ sessionId: probe.sessionId, phone: probe.phone, content: { text }, actor: 'spy-probe', origin: 'spy' })
    for (let waited = 0; waited < PART_SEND_TIMEOUT; waited += SECOND) {
      const message = await this.opts.messages.get(view.id)
      if (message.sentAt) return new Date(message.sentAt)
      if (['failed', 'cancelled'].includes(message.status)) throw new Error(`mensagem não saiu (${message.status})`)
      await this.sleep(SECOND)
    }
    return undefined
  }
}

const URL_RE = /https?:\/\/[^\s"'<>\])]+/gi

/** Junta o que a IA anotou com o que já havia; links da oferta são guardados sempre (mesmo os que a IA não citou). */
export function mergeSummary(prev: SpyProbeSummary, d: { etapa?: string; preco?: string; checkout: string[]; opcoes: string[]; humano: boolean; motivo?: string }, offerTexts: string[]): SpyProbeSummary {
  const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => Boolean(x)))]
  return {
    ...prev,
    ...(d.etapa ? { etapa: d.etapa } : {}),
    ...(d.preco ? { preco: d.preco } : {}),
    checkout: uniq([...(prev.checkout ?? []), ...d.checkout]),
    opcoes: d.opcoes.length ? d.opcoes : prev.opcoes ?? [],
    links: uniq([...(prev.links ?? []), ...offerTexts.flatMap((t) => t.match(URL_RE) ?? [])]),
    humano: prev.humano || d.humano,
    ...(d.motivo ? { notas: d.motivo } : {}),
  }
}
