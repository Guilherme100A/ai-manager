import { describe, expect, it, vi } from 'vitest'
import { RedisConversationStore } from './store'
describe('configuração de rodízio', () => {
  it('preserva modo fixo das configurações antigas e usa rodízio em novas contas', async () => {
    const get = vi.fn(async () => JSON.stringify({ enabled: true, targetSessionId: 'b' }))
    const store = new RedisConversationStore({ get } as never)
    expect((await store.config('a')).mode).toBe('fixed')
    get.mockResolvedValueOnce(null as never)
    expect((await store.config('new')).mode).toBe('rotating')
  })
})
