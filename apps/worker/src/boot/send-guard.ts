// Marca de "envio em curso" (AC-T16-05): gravada IMEDIATAMENTE antes de transport.sendMessage e apagada quando
// o envio retorna. No boot, a reconciliação usa a marca para saber se uma mensagem presa em `processing` pode
// ter chegado ao WhatsApp (marca presente → estado desconhecido) ou nunca saiu do worker (sem marca → reenvio seguro).
//
// Como funciona sem tocar no ponto único de envio (packages/core/src/send/deliver.ts):
// createDeliver faz beforeSend → sleep(delayMs) → sendMessage. O adapter abaixo garante delayMs ≥ 1 quando o envio
// é permitido, e o `sleep` injetado espera o delay e então grava a marca. A sessão vem de um AsyncLocalStorage
// aberto pelo wrapper do DeliverFn. Como a fila tem concorrência 1 por sessão, existe no máximo uma mensagem
// `processing` por sessão, e a marca é por sessão.
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  createDeliver,
  defaultSessionIdOf,
  type AntibanAdapter,
  type AntibanDecision,
  type CreateDeliverOptions,
  type DeliverFn,
  type OutgoingContent,
} from '@wsm/core'

/** Armazenamento durável das marcas (Redis em produção; memória nos testes). */
export interface InflightStore {
  mark(sessionId: string): Promise<void>
  clear(sessionId: string): Promise<void>
  has(sessionId: string): Promise<boolean>
}

/** Subconjunto do ioredis usado pelas marcas. */
export interface RedisKV {
  set(key: string, value: string): Promise<unknown>
  del(key: string): Promise<unknown>
  exists(key: string): Promise<number>
}

export const inflightKey = (prefix: string, sessionId: string) => `${prefix}:send-inflight:${sessionId}`

export function redisInflightStore(redis: RedisKV, prefix = 'wsm'): InflightStore {
  return {
    mark: async (id) => void (await redis.set(inflightKey(prefix, id), new Date().toISOString())),
    clear: async (id) => void (await redis.del(inflightKey(prefix, id))),
    has: async (id) => (await redis.exists(inflightKey(prefix, id))) > 0,
  }
}

export function memoryInflightStore(): InflightStore & { keys: Set<string> } {
  const keys = new Set<string>()
  return {
    keys,
    mark: async (id) => void keys.add(id),
    clear: async (id) => void keys.delete(id),
    has: async (id) => keys.has(id),
  }
}

/** Esperas extras por sessão (controle do FakeTransport, só em WA_TRANSPORT=fake). */
export interface SendDelays {
  /** Antes da marca (simula a espera do antiban). */
  holdBeforeSend(sessionId: string): number
  /** Depois da marca, imediatamente antes do sendMessage (simula um envio lento). */
  sendDelay(sessionId: string): number
}

export interface GuardedDeliverOptions extends Omit<CreateDeliverOptions, 'antiban' | 'sleep' | 'sessionIdOf'> {
  antiban: AntibanAdapter | (() => AntibanAdapter)
  inflight: InflightStore
  sleep?: (ms: number) => Promise<void>
  delays?: SendDelays
}

interface GuardCtx {
  sessionId?: string
  marked: boolean
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Adapter que repassa tudo e garante delayMs ≥ 1 para o `sleep` (ponto da marca) sempre rodar. */
export function withMarkPoint(inner: AntibanAdapter | (() => AntibanAdapter)): AntibanAdapter {
  const get = typeof inner === 'function' ? inner : () => inner
  return {
    get mode() {
      return get().mode
    },
    async beforeSend(key: string, to: string, content: OutgoingContent): Promise<AntibanDecision> {
      const d = await get().beforeSend(key, to, content)
      return d.allowed ? { ...d, delayMs: Math.max(1, d.delayMs) } : d
    },
    afterSend: (key, to, content, messageId) => get().afterSend(key, to, content, messageId),
    afterSendFailed: (key, error) => get().afterSendFailed(key, error),
    onDelivered: (key, messageId) => get().onDelivered(key, messageId),
    stats: (key) => get().stats(key),
  }
}

/** DeliverFn do worker: createDeliver (antiban, 403 → health/limites) + marca de envio em curso. */
export function createGuardedDeliver(opts: GuardedDeliverOptions): DeliverFn {
  const als = new AsyncLocalStorage<GuardCtx>()
  const sleep = opts.sleep ?? realSleep
  const { inflight, delays, antiban, ...rest } = opts
  const inner = createDeliver({
    ...rest,
    antiban: withMarkPoint(antiban),
    sessionIdOf: () => als.getStore()?.sessionId,
    sleep: async (ms) => {
      const ctx = als.getStore()
      const id = ctx?.sessionId
      await sleep(ms + (id && delays ? delays.holdBeforeSend(id) : 0))
      if (ctx && id) {
        await inflight.mark(id)
        ctx.marked = true
        const extra = delays?.sendDelay(id) ?? 0
        if (extra > 0) await sleep(extra)
      }
    },
  })
  return (transport, to, content, meta) => {
    const sessionId = defaultSessionIdOf(transport)
    const ctx: GuardCtx = { marked: false, ...(sessionId ? { sessionId } : {}) }
    return als.run(ctx, async () => {
      try {
        return await inner(transport, to, content, meta)
      } finally {
        // Falha ao apagar não pode virar falha de envio (a mensagem seria reenviada): a marca órfã só faz a
        // reconciliação ser mais conservadora (failed em vez de retrying).
        if (ctx.marked && ctx.sessionId) await inflight.clear(ctx.sessionId).catch(() => undefined)
      }
    })
  }
}
