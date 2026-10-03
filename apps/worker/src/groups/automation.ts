import {
  automationDay, groupEntryCapacity, inviteCodeFromUrl, randomItem, SENDABLE_STATES,
  type GroupAutomationConfig, type GroupInviteService, type GroupModel,
  type ManagedGroup, type MessageQueue, type SendPipeline, type SessionLimitsService, type SessionView, type WaTransport,
} from '@wsm/core'
import type { GroupAutomationStore } from './store'

const DAY = 86_400_000
const LEASE = 300_000
export interface AutomationManager {
  list(): Promise<SessionView[]>
  get(id: string): Promise<SessionView>
  getTransport(id: string): WaTransport | undefined
  isConnected(id: string): boolean
}
export interface GroupAutomationOptions {
  manager: AutomationManager
  store: GroupAutomationStore
  limits: Pick<SessionLimitsService, 'get' | 'countOutbound'>
  pipeline: Pick<SendPipeline, 'sendGroup'>
  messages: Pick<MessageQueue, 'get'>
  model: GroupModel
  invites: GroupInviteService
  audit: (sessionId: string, detail: Record<string, unknown>) => Promise<void>
  logger: { warn(obj: object, message?: string): void }
  now?: () => number
  /** Fonte de aleatoriedade (injetável nos testes). Default: Math.random. */
  random?: () => number
}

const HOUR = 3_600_000
/** Janela (horário de Brasília) em que a mensagem diária pode sair; o minuto exato é sorteado por grupo e por dia. */
const POST_FROM_HOUR = 9
const POST_TO_HOUR = 21

export class GroupAutomation {
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private running = new Map<string, Promise<void>>()
  private readonly now: () => number
  private readonly random: () => number
  constructor(private readonly opts: GroupAutomationOptions) { this.now = opts.now ?? Date.now; this.random = opts.random ?? Math.random }
  /** Sorteia o horário da mensagem de hoje entre agora (ou 9 h) e 21 h; passou da janela, fica para amanhã. */
  private postTime(now: number) {
    const start = Date.parse(`${automationDay(now)}T00:00:00-03:00`)
    const from = Math.max(now, start + POST_FROM_HOUR * HOUR)
    const to = start + POST_TO_HOUR * HOUR
    return from >= to ? start + 24 * HOUR : from + Math.floor(this.random() * (to - from))
  }

  /** Chip "normal" sem proxy (IP) não entra em grupos automaticamente; só chips com proxy entram. O envio continua liberado. */
  private hasProxy(session: SessionView): boolean { return session.proxyId != null }

  async start() {
    this.timer = setInterval(() => void this.tickAll(), 60_000)
    this.timer.unref?.()
    await this.tickAll()
  }
  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    await Promise.allSettled([...this.running.values()])
  }

  async configure(id: string, config: GroupAutomationConfig) {
    await this.opts.manager.get(id)
    if (config.targetSessionId === id) throw new Error('target session must differ from source')
    if (config.targetSessionId) await this.opts.manager.get(config.targetSessionId)
    const previous = await this.opts.store.config(id)
    await this.opts.store.saveConfig(id, config)
    if (previous.query !== config.query || (!previous.enabled && config.enabled)) {
      const state = await this.opts.store.state(id)
      delete state.discovery
      delete state.lastSearchAt
      delete state.lastError
      await this.opts.store.saveState(id, state)
    }
    return this.view(id)
  }
  async view(id: string) {
    await this.opts.manager.get(id)
    const [config, state, limits] = await Promise.all([
      this.opts.store.config(id), this.opts.store.state(id), this.opts.limits.get(id),
    ])
    const transport = this.opts.manager.isConnected(id) ? this.opts.manager.getTransport(id) : undefined
    const groups = transport ? await transport.fetchGroups() : []
    return { config, currentGroups: groups.length, capacity: groupEntryCapacity(limits, (state.entryTimes ?? []).filter((at) => at > this.now() - DAY).length, config.maxEntriesPerDay),
      groups: state.groups.map(({ inviteCode: _code, ...group }) => group), lastError: state.lastError ?? null,
      running: this.running.has(id), lastSearchAt: state.lastSearchAt ?? null, lastJoinAt: state.lastJoinAt ?? null }
  }

  /** Sessão excluída: espera o ciclo em curso dela terminar e apaga configuração e estado. */
  async forget(id: string) {
    await this.running.get(id)
    await this.opts.store.remove(id)
  }

  requestTick(id: string) { if (!this.stopped) this.launch(id); return { queued: !this.stopped } }
  private launch(id: string) {
    if (this.running.has(id)) return
    const run = this.run(id).catch(() => this.opts.logger.warn({ session_id: id }, 'group automation cycle failed'))
    this.running.set(id, run)
    void run.finally(() => this.running.delete(id))
  }
  private async tickAll() {
    if (this.stopped) return
    try {
      for (const session of await this.opts.manager.list()) if (this.opts.manager.isConnected(session.id)) this.launch(session.id)
    } catch { this.opts.logger.warn({}, 'group automation scheduler failed') }
  }

  /** Testável sem WhatsApp/modelo reais; a mesma rotina é chamada pelo timer e pela API. */
  async run(id: string) {
    const lease = await this.opts.store.claim(id, LEASE)
    if (!lease) return
    const renewal = setInterval(() => void this.opts.store.renew(id, lease, LEASE).catch(() => undefined), 60_000)
    renewal.unref?.()
    try {
      const config = await this.opts.store.config(id)
      if (!config.enabled || this.stopped) return
      const session = await this.opts.manager.get(id)
      const transport = this.opts.manager.getTransport(id)
      if (!transport || !this.opts.manager.isConnected(id) || !SENDABLE_STATES.includes(session.status)) return
      const state = await this.opts.store.state(id)
      const now = this.now()
      const actualGroups = await transport.fetchGroups()
      const actualIds = new Set(actualGroups.map((g) => g.id))
      state.groups = state.groups.filter((group) => actualIds.has(group.id) || (group.state === 'pending' && now - group.joinedAt < DAY))
      for (const group of state.groups) if (actualIds.has(group.id)) group.state = 'joined'
      state.entryTimes = (state.entryTimes ?? []).filter((at) => at > now - DAY)
      state.discoveredTimes = (state.discoveredTimes ?? []).filter((at) => at > now - DAY)
      await this.opts.store.saveState(id, state)

      // O limite é de entradas por 24 h; o volume recebido nos grupos não participa desta decisão.
      // Chip com proxy (IP) entra em grupo quando tem vaga. Chip sem proxy NUNCA entra: só descobre o link
      // público para encaminhar aos chips com proxy (e também nunca posta no grupo, mais abaixo).
      const capacity = await this.capacity(id)
      const proxied = this.hasProxy(session)
      // Sem proxy: só descobre se há chip com proxy para receber, nenhum grupo aguardando repasse e cabe no teto
      // de 24 h. Evita pesquisas pagas e consultas de convite ao WhatsApp que ninguém usaria.
      const canDiscover = !proxied && !state.groups.some((g) => !g.forwardedTo) &&
        state.discoveredTimes.length < config.maxEntriesPerDay && (await this.forwardTargets(id, config)).length > 0
      if (proxied ? capacity.canEnter : canDiscover) {
        try {
          if (!state.discovery || state.discovery.query !== config.query || now - state.discovery.at >= DAY) {
            // Persiste antes da chamada para evitar repetir pesquisas pagas em caso de falha/restart.
            state.discovery = { query: config.query, at: now, candidates: [] }
            state.lastSearchAt = now
            await this.opts.store.saveState(id, state)
            state.discovery.candidates = await this.opts.model.discover(config.query)
            await this.opts.store.saveState(id, state)
          }
          const candidates = [...state.discovery.candidates]
          // Códigos já tentados/gerenciados não são selecionados novamente neste cache.
          for (const attempted of state.groups) {
            const index = candidates.findIndex((c) => inviteCodeFromUrl(c.inviteUrl) === attempted.inviteCode)
            if (index >= 0) candidates.splice(index, 1)
          }
          const candidate = randomItem(candidates)
          if (!candidate) { state.lastError = 'Nenhum novo convite público encontrado no cache da busca. A pesquisa será renovada após 24 h.'; await this.opts.store.saveState(id, state) }
          const code = candidate && inviteCodeFromUrl(candidate.inviteUrl)
          if (candidate && code && transport.inspectGroupInvite) {
            const group = await transport.inspectGroupInvite(code)
            const topic = [group.name, group.description, candidate.topic].filter(Boolean).join(' — ').slice(0, 800)
            if (proxied && transport.groupAcceptInvite) {
              const latest = await this.capacity(id)
              if (!actualIds.has(group.id) && latest.canEnter && await this.active(id, transport)) {
                const managed: ManagedGroup = { id: group.id, name: group.name, topic, inviteCode: code, joinedAt: now, state: 'pending' }
                state.groups.push(managed)
                state.lastJoinAt = now
                state.entryTimes.push(now)
                await this.opts.store.saveState(id, state)
                await this.opts.audit(id, { action: 'join_started', groupId: group.id })
                const accepted = await transport.groupAcceptInvite(code)
                if (accepted && accepted !== group.id) throw new Error('group mismatch')
                if ((await transport.fetchGroups()).some((g) => g.id === group.id)) managed.state = 'joined'
                await this.opts.store.saveState(id, state)
                await this.opts.audit(id, { action: 'join_result', groupId: group.id, state: managed.state })
              }
            } else if (!proxied && !state.groups.some((g) => g.inviteCode === code)) {
              // Chip sem proxy: registra o grupo descoberto apenas para encaminhar; NUNCA entra.
              state.groups.push({ id: group.id, name: group.name, topic, inviteCode: code, joinedAt: now, state: 'pending' })
              state.discoveredTimes.push(now)
              await this.opts.store.saveState(id, state)
              await this.opts.audit(id, { action: 'group_discovered', groupId: group.id })
            }
          }
        } catch {
          state.lastError = 'Falha na busca ou entrada. Confira a configuração de IA e o convite; a próxima busca ocorrerá após 24 h.'
          await this.opts.store.saveState(id, state)
        }
      }
      if (!(await this.active(id, transport))) return
      if (!proxied) {
        // Chip sem proxy: só encaminha os grupos descobertos aos chips com proxy; nunca entra nem posta no grupo.
        for (const group of state.groups.filter((g) => !g.forwardedTo)) await this.forward(id, group, config)
        await this.opts.store.saveState(id, state)
        return
      }
      for (const group of state.groups.filter((g) => g.state === 'joined').sort((a, b) => (a.lastPostDay ?? '').localeCompare(b.lastPostDay ?? ''))) {
        if (!group.forwardedTo) await this.forward(id, group, config)
        if (group.lastPostDay === automationDay(now)) continue
        // Horário diferente por grupo e por dia, para a mensagem não sair sempre no mesmo momento.
        if (group.postAt?.day !== automationDay(now)) {
          group.postAt = { day: automationDay(now), at: this.postTime(now) }
          await this.opts.store.saveState(id, state)
        }
        // Antes do horário sorteado ou depois das 21 h (envio atrasado por limite, queda ou falha): fica para amanhã.
        if (group.postAt.at > now || now >= Date.parse(`${automationDay(now)}T00:00:00-03:00`) + POST_TO_HOUR * HOUR) continue
        if (group.lastMessageId) {
          try {
            const previous = await this.opts.messages.get(group.lastMessageId)
            if (['queued', 'retrying', 'processing'].includes(previous.status)) continue
            if (previous.sentAt && automationDay(Date.parse(previous.sentAt)) === automationDay(now)) {
              group.lastPostDay = automationDay(now)
              await this.opts.store.saveState(id, state)
              continue
            }
          } catch { continue }
        }
        if (!(await this.active(id, transport))) break
        const fresh = (await transport.fetchGroups()).find((g) => g.id === group.id)
        if (!fresh || (fresh.announce && !fresh.isAdmin)) continue
        try {
          const limits = await this.opts.limits.get(id)
          let sendCapacity = true
          for (const [window, maximum] of [[60_000, limits.effective.perMinute], [3_600_000, limits.effective.perHour], [DAY, limits.effective.perDay]]) {
            if (await this.opts.limits.countOutbound(id, new Date(now - window!)) >= maximum!) sendCapacity = false
          }
          if (!sendCapacity) break
          const day = automationDay(now)
          if (group.draft?.day !== day) {
            if (group.draftAttemptDay === day) continue
            group.draftAttemptDay = day
            await this.opts.store.saveState(id, state)
            const previous = group.draft?.text
            group.draft = { day, text: await this.opts.model.message(group.name, group.topic, previous) }
            await this.opts.store.saveState(id, state)
          }
          const text = group.draft.text
          if (!(await this.active(id, transport))) break
          // Marca antes do enqueue: uma queda nunca produz duas mensagens automáticas no mesmo dia.
          group.lastPostDay = automationDay(now)
          await this.opts.store.saveState(id, state)
          const message = await this.opts.pipeline.sendGroup({ sessionId: id, groupId: group.id, content: { text }, actor: 'group-automation' })
          group.lastMessageId = message.id
          delete state.lastError
          await this.opts.store.saveState(id, state)
          await this.opts.audit(id, { action: 'daily_message_queued', groupId: group.id, messageId: message.id })
        } catch (error) {
          // Gates rejeitados não criaram mensagem: permite reavaliar capacidade no próximo ciclo.
          if (error && typeof error === 'object' && 'name' in error && error.name === 'SendRejectedError') delete group.lastPostDay
          state.lastError = 'Mensagem diária adiada ou falhou. Verifique limites e a fila de mensagens.'
          await this.opts.store.saveState(id, state)
        }
      }
      await this.opts.store.saveState(id, state)
    } finally {
      clearInterval(renewal)
      await this.opts.store.release(id, lease)
    }
  }
  private async active(id: string, transport: WaTransport) {
    return !this.stopped && (await this.opts.store.config(id)).enabled && this.opts.manager.isConnected(id) &&
      this.opts.manager.getTransport(id) === transport && SENDABLE_STATES.includes((await this.opts.manager.get(id)).status)
  }
  private async capacity(id: string) {
    const config = await this.opts.store.config(id)
    const state = await this.opts.store.state(id)
    return groupEntryCapacity(await this.opts.limits.get(id), (state.entryTimes ?? []).filter((at) => at > this.now() - DAY).length, config.maxEntriesPerDay)
  }
  /** Chips que podem receber um grupo repassado por `id`: só com proxy (IP), conectados, ativos e com automação ligada. */
  private async forwardTargets(id: string, config: GroupAutomationConfig) {
    const candidates = (await this.opts.manager.list()).filter((s) => s.id !== id && (!config.targetSessionId || s.id === config.targetSessionId))
    const eligible = []
    for (const candidate of candidates) {
      if (this.hasProxy(candidate) && SENDABLE_STATES.includes(candidate.status) && this.opts.manager.isConnected(candidate.id) && (await this.opts.store.config(candidate.id)).enabled) eligible.push(candidate)
    }
    return eligible
  }
  private async forward(id: string, group: ManagedGroup, config: GroupAutomationConfig) {
    const target = randomItem(await this.forwardTargets(id, config))
    if (!target) return
    const lease = await this.opts.store.claim(target.id, LEASE)
    if (!lease) return
    try {
      const transport = this.opts.manager.getTransport(target.id)
      if (!transport) return
      const groups = await transport.fetchGroups()
      const state = await this.opts.store.state(target.id)
      if (groups.some((g) => g.id === group.id)) { group.forwardedTo = target.id; return }
      if (!(await this.capacity(target.id)).canEnter) return
      if (!await this.active(target.id, transport)) return
      // Marca a tentativa antes do aceite; reinício não causa várias entradas seguidas.
      state.lastJoinAt = this.now()
      state.entryTimes = [...(state.entryTimes ?? []).filter((at) => at > this.now() - DAY), this.now()]
      state.groups.push({ ...group, joinedAt: this.now(), state: 'pending', forwardedTo: id, lastPostDay: undefined, draft: undefined, draftAttemptDay: undefined, lastMessageId: undefined })
      await this.opts.store.saveState(target.id, state)
      const out = await this.opts.invites.run({ sourceSessionId: id, targetSessionId: target.id, groupIds: [group.id], actor: 'group-automation' }, { groupId: group.id, code: group.inviteCode })
      const managed = state.groups.find((g) => g.id === group.id)!
      managed.state = out.result === 'joined' ? 'joined' : 'pending'
      await this.opts.store.saveState(target.id, state)
      group.forwardedTo = target.id
    } catch {
      this.opts.logger.warn({ session_id: id, target_session_id: target.id }, 'group invitation forwarding deferred')
    } finally { await this.opts.store.release(target.id, lease) }
  }
}
