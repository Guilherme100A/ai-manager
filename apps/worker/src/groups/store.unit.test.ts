import { describe, expect, it, vi } from 'vitest'
import { RedisGroupAutomationStore } from './store'
describe('configuração da automação de grupos', () => {
  it('com autoEnable, contas sem configuração vêm ativas; as salvas são respeitadas', async () => {
    const get = vi.fn(async () => null as string | null)
    const store = new RedisGroupAutomationStore({ get } as never, 'wsm', true)
    expect((await store.config('new')).enabled).toBe(true)
    get.mockResolvedValueOnce(JSON.stringify({ enabled: false }))
    expect((await store.config('off')).enabled).toBe(false)
    expect((await new RedisGroupAutomationStore({ get } as never).config('legacy')).enabled).toBe(false)
  })
})
