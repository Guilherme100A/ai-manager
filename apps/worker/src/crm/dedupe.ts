// Idempotência do envio do CRM (A8) por (sessionId, clientMessageId), sem coluna nova em `public.messages`:
// SET NX 'pending' reserva o id; depois do enqueue a chave guarda o id da mensagem. Falha no envio libera a reserva.
// Repetição com o mesmo par devolve a mensagem já enfileirada (mesmo id).

/** Subconjunto do ioredis usado aqui (fake nos testes). */
export interface DedupeRedis {
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  get(key: string): Promise<string | null>
  del(key: string): Promise<unknown>
}

export const DEFAULT_DEDUPE_TTL_SECONDS = 7 * 24 * 3600
const PENDING = 'pending'

export class DedupeConflictError extends Error {
  readonly code = 'CONFLICT'
  readonly status = 409
  constructor(clientMessageId: string) {
    super(`send with clientMessageId ${clientMessageId} is still in progress`)
    this.name = 'DedupeConflictError'
  }
}

export interface ClientMessageDedupeOptions {
  /** Prefixo das chaves (o do Redis do ai-manager: `wsm`). */
  prefix?: string
  ttlSeconds?: number
  /** Quanto esperar por um envio concorrente com o mesmo id antes de responder CONFLICT. */
  waitMs?: number
  pollMs?: number
}

export class ClientMessageDedupe {
  readonly prefix: string
  readonly ttl: number
  private readonly waitMs: number
  private readonly pollMs: number

  constructor(
    private readonly redis: DedupeRedis,
    opts: ClientMessageDedupeOptions = {},
  ) {
    this.prefix = opts.prefix ?? 'wsm'
    this.ttl = opts.ttlSeconds ?? DEFAULT_DEDUPE_TTL_SECONDS
    this.waitMs = opts.waitMs ?? 5000
    this.pollMs = opts.pollMs ?? 50
  }

  key(sessionId: string, clientMessageId: string): string {
    return `${this.prefix}:crm:client-msg:${sessionId}:${clientMessageId}`
  }

  /** Sem `clientMessageId` só envia. Com ele, envia uma vez e devolve a mesma mensagem nas repetições. */
  async run<T extends { id: string }>(sessionId: string, clientMessageId: string | undefined, send: () => Promise<T>, lookup: (messageId: string) => Promise<T>): Promise<T> {
    if (!clientMessageId) return send()
    const key = this.key(sessionId, clientMessageId)
    const reserved = await this.redis.set(key, PENDING, 'EX', this.ttl, 'NX')
    if (reserved) {
      try {
        const message = await send()
        await this.redis.set(key, message.id, 'EX', this.ttl)
        return message
      } catch (err) {
        await this.redis.del(key).catch(() => undefined)
        throw err
      }
    }
    const deadline = Date.now() + this.waitMs
    for (;;) {
      const value = await this.redis.get(key)
      if (value && value !== PENDING) return lookup(value)
      // A reserva expirou ou foi liberada por uma falha: tenta de novo do zero.
      if (value === null) return this.run(sessionId, clientMessageId, send, lookup)
      if (Date.now() > deadline) throw new DedupeConflictError(clientMessageId)
      await new Promise((r) => setTimeout(r, this.pollMs))
    }
  }
}
