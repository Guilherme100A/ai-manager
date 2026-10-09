// Conversas dos chips com proxy com os números de autoresposta (próprios do operador). Rodam ao lado do rodízio
// entre chips e dividem o mesmo limite diário do chip: a cada intervalo, o chip manda 1 ou 2 mensagens curtas
// (com "digitando…") para o número que está há mais tempo sem receber dele; a resposta automática chega sozinha.
import {
  conversationConfigSchema, phoneToUserJid, SENDABLE_STATES,
  type AutoReplyTargets, type ConversationConfig, type ConversationModel, type ConversationTurn,
  type SendPipeline, type SessionLimitsService, type SessionView, type WaTransport,
} from '@wsm/core'
import { conversationDailyLimit } from './automation'

const MINUTE = 60_000
const DAY = 86_400_000
/** Um mesmo número recebe do mesmo chip no máximo a cada 60 min. */
export const AUTOREPLY_MIN_GAP_PER_NUMBER = 60 * MINUTE
const EXTERNAL = 'autoresposta'

export interface AutoReplyOptions {
  manager: {
    list(): Promise<SessionView[]>
    isConnected(id: string): boolean
    getTransport(id: string): WaTransport | undefined
  }
  config(id: string): Promise<ConversationConfig>
  targets: Pick<AutoReplyTargets, 'phones' | 'history' | 'lastSentByPhone'>
  limits: Pick<SessionLimitsService, 'get' | 'countOutbound'>
  pipeline: Pick<SendPipeline, 'send'>
  model: ConversationModel
  audit(sessionId: string, detail: Record<string, unknown>): Promise<void>
  logger: { warn(obj: object, message?: string): void }
  paused?: () => boolean
  activity?: { mark(label: string): void }
  now?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class AutoReplyAutomation {
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private stopped = false
  private readonly nextAt = new Map<string, number>()
  private readonly now: () => number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: AutoReplyOptions) {
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? Math.random
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  start() {
    this.timer = setInterval(() => this.launch(), MINUTE)
    this.timer.unref?.()
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await this.running
  }

  private launch() {
    if (this.stopped || this.running || this.opts.paused?.()) return
    this.opts.activity?.mark('autoresposta:ciclo')
    this.running = this.tick()
      .catch((err: unknown) => this.opts.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'autoreply cycle failed'))
      .finally(() => { this.running = undefined })
  }

  async tick() {
    const phones = await this.opts.targets.phones()
    if (!phones.length) return
    for (const s of await this.opts.manager.list()) {
      if (this.stopped) return
      // Só chips com proxy falam com os números de autoresposta.
      if (!s.proxyId || !s.phone || !this.opts.manager.isConnected(s.id) || !SENDABLE_STATES.includes(s.status)) continue
      await this.run(s, phones).catch((err: unknown) =>
        this.opts.logger.warn({ session_id: s.id, err: err instanceof Error ? err.message : String(err) }, 'autoreply turn failed'))
    }
  }

  private async room(id: string, config: ConversationConfig) {
    const limits = await this.opts.limits.get(id)
    let room = Infinity
    for (const [window, maximum] of [[MINUTE, limits.effective.perMinute], [60 * MINUTE, limits.effective.perHour], [DAY, conversationDailyLimit(config.maxMessagesPerDay, limits.effective, true)]] as const) {
      room = Math.min(room, maximum - await this.opts.limits.countOutbound(id, new Date(this.now() - window)))
    }
    return Math.max(0, room)
  }

  async run(s: SessionView, phones: string[]) {
    const now = this.now()
    if ((this.nextAt.get(s.id) ?? 0) > now) return
    const config = conversationConfigSchema.parse(await this.opts.config(s.id))
    if (!config.enabled) return
    // Próxima tentativa com variação, para não sair sempre no mesmo ritmo.
    this.nextAt.set(s.id, now + config.intervalMinutes * MINUTE * (0.8 + this.random() * 0.6))
    const room = await this.room(s.id, config)
    if (room <= 0) return
    const last = await this.opts.targets.lastSentByPhone(s.id)
    const eligible = phones.filter((p) => now - (last.get(p) ?? 0) >= AUTOREPLY_MIN_GAP_PER_NUMBER)
    if (!eligible.length) return
    // Quem está há mais tempo sem mensagem deste chip; empate (ex.: nunca recebeu) é sorteado.
    const oldest = Math.min(...eligible.map((p) => last.get(p) ?? 0))
    const tied = eligible.filter((p) => (last.get(p) ?? 0) === oldest)
    const phone = tied[Math.floor(this.random() * tied.length)]!
    const history: ConversationTurn[] = (await this.opts.targets.history(s.id, phone))
      .map((t) => ({ senderId: t.fromChip ? s.id : EXTERNAL, text: t.text }))
    const parts = this.random() < 0.6 ? 1 : 2
    const text = await this.opts.model.message(config.topic, s.id, history, parts)
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, Math.min(parts, room))
    const transport = this.opts.manager.getTransport(s.id)
    const jid = phoneToUserJid(phone)
    for (const [index, line] of lines.entries()) {
      if (this.stopped) return
      // "digitando…" proporcional ao tamanho, como uma pessoa.
      await transport?.sendTyping?.(jid, true).catch(() => undefined)
      await this.sleep(Math.min(6_000, 1_200 + line.length * 60))
      await transport?.sendTyping?.(jid, false).catch(() => undefined)
      const message = await this.opts.pipeline.send({ sessionId: s.id, phone, content: { text: line }, actor: 'autoreply-conversations' })
      await this.opts.audit(s.id, { action: 'autoreply_turn', phone, messageId: message.id, part: index + 1, parts: lines.length })
    }
  }
}
