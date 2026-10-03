// Simulação (fuzz) da conversa entre contas: milhares de cenários aleatórios com falhas injetadas — gate recusando,
// fila falhando ou travando, erro incerto, worker morrendo no meio de um disparo, quedas de conexão, IA inválida —
// conferindo invariantes a cada passo. Determinística por seed: uma falha é reproduzível pelo número do seed.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONVERSATION_CONFIG, type ConversationConfig, type ConversationState, type SessionView } from '@wsm/core'
import { ConversationAutomation } from './automation'
import type { ConversationStore } from './store'

const MINUTE = 60_000
const DAY = 86_400_000

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Faults { reject: number; uncertain: number; queueFail: number; queueStuck: number; crash: number; restart: number; disconnect: number; modelError: number; slowDelivery: number }
const NO_FAULTS: Faults = { reject: 0, uncertain: 0, queueFail: 0, queueStuck: 0, crash: 0, restart: 0, disconnect: 0, modelError: 0, slowDelivery: 0 }

interface Msg { id: string; from: string; to: string; text: string; createdAt: number; sentAt?: number; deliveredAt?: number; status: 'queued' | 'sent' | 'failed' | 'cancelled' }

class Crash extends Error { constructor() { super('processo morreu'); this.name = 'Crash' } }

function world(seed: number, ids = ['A', 'B']) {
  const rand = mulberry32(seed)
  let faults = { ...NO_FAULTS }
  let now = Date.parse('2026-10-03T12:00:00Z')
  const sessions = new Map(ids.map((id, i) => [id, { id, phone: `+5511999990${i}0`, status: 'WARMING' } as SessionView]))
  const connected = new Set(ids)
  const offlineUntil = new Map<string, number>()
  const configs = new Map<string, ConversationConfig>(ids.map((id) => [id, { ...DEFAULT_CONVERSATION_CONFIG, mode: 'rotating', enabled: true, maxMessagesPerDay: 60, intervalMinutes: 5, turnsPerConversation: 6 }]))
  const states = new Map<string, ConversationState>()
  let lease: { token: string; until: number } | undefined
  let gen = 0
  const msgs: Msg[] = []
  const log = { modelCalls: 0, typing: 0, crashes: 0, uncertain: 0, failed: 0, violations: [] as string[] }
  let modelSeq = 0

  const phoneOwner = (phone: string) => [...sessions.values()].find((s) => s.phone === phone)!.id
  // A fila "anda" com o tempo: sai entre 0,5 e 4 s; às vezes falha ou trava; entrega 1 a 6 s depois (ou bem depois).
  function settle() {
    for (const m of msgs) {
      if (m.status !== 'queued' || m.createdAt > now) continue
      if ((m as { stuck?: boolean }).stuck) continue
      const sendAt = m.createdAt + 500 + Math.floor(((m.id.length * 7919) % 3500))
      if (now >= sendAt) {
        m.status = 'sent'; m.sentAt = sendAt
        m.deliveredAt = sendAt + ((m as { slow?: boolean }).slow ? 20 * MINUTE : 1_000 + (m.text.length % 5_000))
      }
    }
  }

  function instance() {
    const myGen = gen
    const alive = () => myGen === gen
    const maybeCrash = () => {
      if (alive() && rand() < faults.crash) { gen++; log.crashes++ }
      if (!alive()) throw new Crash()
    }
    const store: ConversationStore = {
      config: async (id) => structuredClone(configs.get(id) ?? DEFAULT_CONVERSATION_CONFIG),
      saveConfig: async (id, v) => { maybeCrash(); configs.set(id, structuredClone(v)) },
      state: async (id) => structuredClone(states.get(id) ?? { history: [], turns: 0 }),
      saveState: async (id, v) => { maybeCrash(); states.set(id, structuredClone(v)) },
      remove: async (id) => { configs.delete(id); states.delete(id) },
      claim: async () => {
        if (!alive() || (lease && lease.until > now)) return undefined
        const token = `${myGen}-${rand()}`; lease = { token, until: now + 120_000 }; return token
      },
      renew: async (token) => { if (!alive() || lease?.token !== token || lease.until <= now) return false; lease.until = now + 120_000; return true },
      release: async (token) => { if (alive() && lease?.token === token) lease = undefined },
    }
    const pipeline = {
      send: async (input: { sessionId: string; phone: string; content: { text: string } }) => {
        maybeCrash()
        if (rand() < faults.reject) throw Object.assign(new Error('gate'), { name: 'SendRejectedError' })
        const m: Msg = { id: `m${msgs.length + 1}-${'x'.repeat(Math.floor(rand() * 9))}`, from: input.sessionId, to: phoneOwner(input.phone), text: input.content.text, createdAt: now, status: 'queued' }
        if (rand() < faults.queueStuck) (m as { stuck?: boolean }).stuck = true
        if (rand() < faults.slowDelivery) (m as { slow?: boolean }).slow = true
        const uncertain = rand() < faults.uncertain
        if (uncertain && rand() < 0.5) { log.uncertain++; throw new Error('timeout incerto (não criou)') }
        msgs.push(m)
        if (rand() < faults.queueFail) { m.status = 'failed'; log.failed++ }
        if (uncertain) { log.uncertain++; throw new Error('timeout incerto (criou)') }
        return { id: m.id }
      },
    }
    const messages = {
      get: async (id: string) => {
        settle()
        const m = msgs.find((x) => x.id === id)
        if (!m) throw new Error('mensagem inexistente')
        return { status: m.status, sentAt: m.sentAt ? new Date(m.sentAt).toISOString() : null }
      },
      cancel: async (id: string) => {
        const m = msgs.find((x) => x.id === id)
        if (!m || m.status !== 'queued') throw new Error('não cancelável')
        m.status = 'cancelled'
        return {}
      },
    }
    const findOutbound = async (senderId: string, phone: string, text: string, since: number) =>
      msgs.find((m) => m.from === senderId && sessions.get(m.to)!.phone === phone && m.text === text && m.createdAt >= since - 5_000)?.id
    const manager = {
      list: async () => [...sessions.values()], get: async (id: string) => sessions.get(id)!,
      isConnected: (id: string) => connected.has(id),
      getTransport: (id: string) => connected.has(id) ? { sendTyping: async () => { log.typing++ } } : undefined,
    }
    const model = {
      message: async (_topic: string, sender: string, _history: unknown, parts = 1) => {
        maybeCrash()
        log.modelCalls++
        if (rand() < faults.modelError) throw new Error('Fala gerada inválida.')
        const n = ++modelSeq
        return Array.from({ length: parts }, (_, i) => `${sender}#${n}.${i + 1}`).join('\n')
      },
    }
    const limits = {
      get: async () => ({ effective: { perMinute: 8, perHour: 60, perDay: 200 } }),
      countOutbound: async (id: string, since: Date) => msgs.filter((m) => m.from === id && m.createdAt > since.getTime()).length,
    }
    const automation = new ConversationAutomation({
      manager: manager as never, store, limits: limits as never, pipeline: pipeline as never, messages: messages as never, model, findOutbound,
      allowed: async () => true,
      received: async (receiverId, phone, text, since) => {
        settle()
        return msgs.some((m) => m.to === receiverId && sessions.get(m.from)!.phone === phone && m.text === text && m.createdAt >= since && m.deliveredAt !== undefined && m.deliveredAt <= now)
      },
      audit: async () => undefined, logger: { warn: () => undefined }, now: () => now, random: rand,
      sleep: async (ms) => { now += ms; settle() },
    })
    return { automation, alive }
  }

  let current = instance()
  const restart = () => { gen++; current = instance() }

  function checkInvariants(where: string) {
    // 1) Nenhuma parte (texto único gerado pela IA) aceita duas vezes pela fila.
    const seen = new Set<string>()
    for (const m of msgs) {
      if (seen.has(m.text)) log.violations.push(`${where}: duplicada "${m.text}"`)
      seen.add(m.text)
    }
    // 2) Dentro da rodada, o histórico sempre alterna as contas.
    for (const [id, s] of states) {
      for (let i = 1; i < s.history.length; i++) {
        if (s.history[i]!.senderId === s.history[i - 1]!.senderId) log.violations.push(`${where}: ${id} sem alternância ${JSON.stringify(s.history.map((h) => h.senderId))}`)
      }
      // 3) Interrompida só com motivo registrado.
      if (s.halted && !s.lastError) log.violations.push(`${where}: ${id} interrompida sem motivo`)
    }
    // 4) Partes de um disparo saem em ordem e da mesma conta.
    const byCall = new Map<string, Msg[]>()
    for (const m of msgs) { const call = m.text.split('.')[0]!; byCall.set(call, [...(byCall.get(call) ?? []), m]) }
    for (const [call, parts] of byCall) {
      const order = parts.map((p) => Number(p.text.split('.')[1]))
      if (order.some((n, i) => n !== i + 1)) log.violations.push(`${where}: partes fora de ordem/puladas em ${call}: ${order}`)
      if (!call.startsWith(parts[0]!.from + '#')) log.violations.push(`${where}: ${call} enviado pela conta errada`)
      for (let i = 1; i < parts.length; i++) {
        if (parts[i]!.createdAt < (parts[i - 1]!.sentAt ?? Infinity)) log.violations.push(`${where}: ${call} parte ${i + 1} enfileirada antes da anterior sair`)
      }
    }
    // 5) Limite diário respeitado (o disparo pode passar no máximo 2 partes do teto por janela).
    for (const id of sessions.keys()) {
      const cap = configs.get(id)?.maxMessagesPerDay ?? 0
      const out = msgs.filter((m) => m.from === id)
      for (const m of out) {
        const inWindow = out.filter((x) => x.createdAt > m.createdAt - DAY && x.createdAt <= m.createdAt).length
        if (inWindow > cap + 2) { log.violations.push(`${where}: ${id} passou do limite diário (${inWindow}/${cap})`); break }
      }
    }
  }

  async function step() {
    now += MINUTE
    settle()
    for (const id of sessions.keys()) {
      if (offlineUntil.has(id) && offlineUntil.get(id)! <= now) { offlineUntil.delete(id); connected.add(id) }
      else if (connected.has(id) && rand() < faults.disconnect) { connected.delete(id); offlineUntil.set(id, now + Math.floor(rand() * 20) * MINUTE) }
    }
    if (rand() < faults.restart) restart()
    const { automation } = current
    try {
      await automation.distribute()
      for (const id of sessions.keys()) await automation.run(id)
    } catch (err) {
      if (!(err instanceof Crash)) log.violations.push(`exceção não tratada: ${String(err)}`)
    }
    if (!current.alive()) restart() // morreu no meio: o worker sobe de novo
  }

  return {
    log, msgs, states, sessions,
    setFaults: (f: Partial<Faults>) => { faults = { ...NO_FAULTS, ...f } },
    run: async (steps: number, where: string) => { for (let i = 0; i < steps; i++) { await step(); checkInvariants(`${where}#${i}`); if (log.violations.length) return } },
    now: () => now,
  }
}

const SEEDS = Number(process.env.SIM_SEEDS ?? 30)

describe('simulação da conversa entre contas', () => {
  it(`sem falhas: alterna, quebra em partes, respeita limites e nunca trava (${SEEDS} seeds)`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = world(seed)
      await w.run(24 * 60, `seed ${seed}`)
      expect(w.log.violations, `seed ${seed}`).toEqual([])
      expect([...w.states.values()].some((s) => s.halted), `seed ${seed} interrompeu sem falha`).toBe(false)
      expect(w.msgs.length, `seed ${seed} enviou pouco`).toBeGreaterThan(20)
      expect(w.log.typing, `seed ${seed} sem digitando`).toBeGreaterThanOrEqual(w.msgs.length)
    }
  }, 600_000)

  it(`com falhas injetadas: nunca duplica, nunca embaralha, nunca estoura limite (${SEEDS} seeds)`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = world(10_000 + seed)
      w.setFaults({ reject: 0.08, uncertain: 0.01, queueFail: 0.02, queueStuck: 0.01, crash: 0.01, restart: 0.01, disconnect: 0.01, modelError: 0.05, slowDelivery: 0.03 })
      await w.run(12 * 60, `seed ${10_000 + seed} caos`)
      expect(w.log.violations, `seed ${10_000 + seed}`).toEqual([])
    }
  }, 600_000)

  it(`depois das falhas pararem, a conversa volta a andar sem intervenção (${SEEDS} seeds)`, async () => {
    const stuck: string[] = []
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = world(20_000 + seed)
      w.setFaults({ reject: 0.1, queueStuck: 0.02, crash: 0.02, restart: 0.02, disconnect: 0.02, modelError: 0.1, slowDelivery: 0.05 })
      await w.run(6 * 60, `seed ${20_000 + seed} caos`)
      w.setFaults({})
      const before = w.msgs.length
      await w.run(12 * 60, `seed ${20_000 + seed} calmo`)
      expect(w.log.violations, `seed ${20_000 + seed}`).toEqual([])
      if (w.msgs.length === before) stuck.push(`seed ${20_000 + seed}: ${JSON.stringify([...w.states.entries()].map(([id, s]) => [id, s.halted, s.lastError, s.pending && 'pending']))}`)
    }
    expect(stuck).toEqual([])
  }, 600_000)
})
