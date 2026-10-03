// Últimas mensagens de cada grupo, por sessão (lista Redis), para a postagem automática ter o contexto da conversa.
// As mensagens de grupo não vão para o banco (lá ficam só as de contatos), então são guardadas aqui, com limite e
// validade: no máximo HISTORY_MAX por grupo e somem após HISTORY_TTL sem novas mensagens.
import type { Redis } from 'ioredis'
import type { GroupHistoryEntry, IncomingMessage } from '@wsm/core'

export const HISTORY_MAX = 30
const HISTORY_TTL_SECONDS = 7 * 24 * 3600

export interface GroupHistory {
  record(sessionId: string, groupId: string, entry: GroupHistoryEntry): Promise<void>
  /** Mais antiga primeiro. */
  recent(sessionId: string, groupId: string, limit?: number): Promise<GroupHistoryEntry[]>
  forget(sessionId: string): Promise<void>
}

const key = (prefix: string, sessionId: string, groupId: string) => `${prefix}:groups:history:${sessionId}:${groupId}`

export function redisGroupHistory(redis: Redis, prefix = 'wsm'): GroupHistory {
  return {
    async record(sessionId, groupId, entry) {
      const k = key(prefix, sessionId, groupId)
      await redis.multi().lpush(k, JSON.stringify(entry)).ltrim(k, 0, HISTORY_MAX - 1).expire(k, HISTORY_TTL_SECONDS).exec()
    },
    async recent(sessionId, groupId, limit = 15) {
      const raw = await redis.lrange(key(prefix, sessionId, groupId), 0, limit - 1)
      return raw.flatMap((item) => { try { return [JSON.parse(item) as GroupHistoryEntry] } catch { return [] } }).reverse()
    },
    async forget(sessionId) {
      const keys = await redis.keys(`${prefix}:groups:history:${sessionId}:*`)
      if (keys.length) await redis.del(...keys)
    },
  }
}

/** Mensagem de grupo com texto → entrada do histórico; outras (contatos, mídia sem legenda) → undefined. */
export function groupHistoryEntry(msg: IncomingMessage): { groupId: string; entry: GroupHistoryEntry } | undefined {
  if (!msg.from.endsWith('@g.us') || !msg.text?.trim()) return undefined
  return { groupId: msg.from, entry: { author: msg.pushName ?? '', text: msg.text, at: msg.timestamp, fromMe: msg.fromMe } }
}
