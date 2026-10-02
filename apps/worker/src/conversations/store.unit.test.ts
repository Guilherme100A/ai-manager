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
  it('com autoRotate, contas sem configuração entram ativas no rodízio; as salvas são respeitadas', async () => {
    const get = vi.fn(async () => null as string | null)
    const store = new RedisConversationStore({ get } as never, true)
    expect(await store.config('new')).toMatchObject({ mode: 'rotating', enabled: true })
    get.mockResolvedValueOnce(JSON.stringify({ mode: 'rotating', enabled: false }))
    expect((await store.config('off')).enabled).toBe(false)
    expect((await new RedisConversationStore({ get } as never).config('legacy')).enabled).toBe(false)
  })
})
