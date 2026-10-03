import { describe, expect, it } from 'vitest'
import { groupHistoryEntry, HISTORY_MAX, redisGroupHistory } from './history'

function fakeRedis() {
  const lists = new Map<string, string[]>()
  const list = (k: string) => lists.get(k) ?? lists.set(k, []).get(k)!
  const redis = {
    lists,
    multi() {
      const ops: Array<() => void> = []
      const chain = {
        lpush: (k: string, v: string) => { ops.push(() => list(k).unshift(v)); return chain },
        ltrim: (k: string, start: number, stop: number) => { ops.push(() => lists.set(k, list(k).slice(start, stop + 1))); return chain },
        expire: () => chain,
        exec: async () => { ops.forEach((op) => op()); return [] },
      }
      return chain
    },
    lrange: async (k: string, start: number, stop: number) => list(k).slice(start, stop + 1),
    keys: async (pattern: string) => [...lists.keys()].filter((k) => k.startsWith(pattern.replace('*', ''))),
    del: async (...keys: string[]) => { keys.forEach((k) => lists.delete(k)); return keys.length },
  }
  return redis
}

describe('histórico dos grupos', () => {
  it('guarda por sessão e grupo, devolve da mais antiga para a mais recente e limita o tamanho', async () => {
    const redis = fakeRedis()
    const history = redisGroupHistory(redis as never)
    for (let i = 0; i < HISTORY_MAX + 5; i++) await history.record('s1', 'g@g.us', { author: `p${i}`, text: `fala ${i}`, at: i })
    await history.record('s2', 'g@g.us', { author: 'x', text: 'outra sessão', at: 1 })
    const recent = await history.recent('s1', 'g@g.us', 3)
    expect(recent.map((m) => m.text)).toEqual([`fala ${HISTORY_MAX + 2}`, `fala ${HISTORY_MAX + 3}`, `fala ${HISTORY_MAX + 4}`])
    expect(redis.lists.get('wsm:groups:history:s1:g@g.us')).toHaveLength(HISTORY_MAX)
    await history.forget('s1')
    expect(await history.recent('s1', 'g@g.us')).toEqual([])
    expect(await history.recent('s2', 'g@g.us')).toHaveLength(1)
  })
  it('só mensagens de grupo com texto entram no histórico', () => {
    const base = { id: '1', fromMe: false, timestamp: 5, type: 'conversation' }
    expect(groupHistoryEntry({ ...base, from: '123@g.us', text: 'oi', pushName: 'Ana' })).toEqual({ groupId: '123@g.us', entry: { author: 'Ana', text: 'oi', at: 5, fromMe: false } })
    expect(groupHistoryEntry({ ...base, from: '5511@s.whatsapp.net', text: 'oi' })).toBeUndefined()
    expect(groupHistoryEntry({ ...base, from: '123@g.us', type: 'imageMessage' })).toBeUndefined()
    expect(groupHistoryEntry({ ...base, from: '123@g.us', text: '   ' })).toBeUndefined()
  })
})
