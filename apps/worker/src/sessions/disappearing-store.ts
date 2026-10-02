// Tempos das mensagens temporárias por conversa, por sessão (hash Redis JID → segundos). Sobrevive a reinícios
// do worker: sem isso, numa conversa só entre automações o tempo só seria reaprendido se alguém mexesse nele.
import type { Redis } from 'ioredis'
import type { DisappearingStore } from '@wsm/core'

export const disappearingKey = (sessionId: string, prefix = 'wsm') => `${prefix}:disappearing:${sessionId}`

export function redisDisappearingStore(redis: Redis, sessionId: string, prefix = 'wsm'): DisappearingStore {
  const key = disappearingKey(sessionId, prefix)
  return {
    async load() {
      const raw = await redis.hgetall(key)
      return Object.fromEntries(Object.entries(raw).map(([jid, seconds]) => [jid, Number(seconds)]).filter(([, s]) => (s as number) > 0))
    },
    async save(jid, seconds) {
      if (seconds > 0) await redis.hset(key, jid, String(seconds))
      else await redis.hdel(key, jid)
    },
  }
}
