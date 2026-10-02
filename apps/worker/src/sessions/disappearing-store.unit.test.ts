import { describe, expect, it } from 'vitest'
import { disappearingKey, redisDisappearingStore } from './disappearing-store'

function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>()
  const hash = (key: string) => hashes.get(key) ?? hashes.set(key, new Map()).get(key)!
  return {
    hashes,
    hgetall: async (key: string) => Object.fromEntries(hash(key)),
    hset: async (key: string, field: string, value: string) => { hash(key).set(field, value); return 1 },
    hdel: async (key: string, field: string) => Number(hash(key).delete(field)),
  }
}

describe('tempos de mensagens temporárias no Redis', () => {
  it('salva por sessão, recarrega como número e remove ao desligar', async () => {
    const redis = fakeRedis()
    const store = redisDisappearingStore(redis as never, 's1')
    await store.save('1@s.whatsapp.net', 86_400)
    await store.save('2@lid', 604_800)
    expect(await store.load()).toEqual({ '1@s.whatsapp.net': 86_400, '2@lid': 604_800 })
    await store.save('2@lid', 0)
    expect(await store.load()).toEqual({ '1@s.whatsapp.net': 86_400 })
    expect(await redisDisappearingStore(redis as never, 's2').load()).toEqual({})
    expect([...redis.hashes.keys()]).toContain(disappearingKey('s1'))
  })
})
