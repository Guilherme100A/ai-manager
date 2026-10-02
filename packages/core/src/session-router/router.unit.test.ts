import { describe, expect, it, vi } from 'vitest'
import { SessionRouter } from './router'
import type { RouterDependencies, SessionLink } from './types'

const link: SessionLink = { id: 'link', sourceSessionId: 'A', targetSessionId: 'B', enabled: true, createdBy: 'admin', rules: { matchText: 'oi', replyText: 'Olá!' } }
const event = { sessionId: 'A', inboundId: 'wa-1', phone: '+5511988887777', text: 'oi' }

function setup(overrides: Partial<RouterDependencies> = {}) {
  const claims = new Set<string>()
  const deps: RouterDependencies = {
    links: vi.fn(async () => [link]),
    isManagedPhone: vi.fn(async () => false),
    contactAllowed: vi.fn(async () => true),
    claim: vi.fn(async (id, inbound) => {
      const key = `${id}:${inbound}`
      if (claims.has(key)) return false
      claims.add(key)
      return true
    }),
    finish: vi.fn(async () => {}),
    send: vi.fn(async () => ({ id: 'outbound' })),
    ...overrides,
  }
  return { deps, router: new SessionRouter(deps) }
}

describe('SessionRouter', () => {
  it('A recebe oi: B responde ao mesmo contato pelo pipeline', async () => {
    const { deps, router } = setup()
    expect(await router.route({ ...event, text: ' OI ' })).toBe(1)
    expect(deps.send).toHaveBeenCalledWith({ sessionId: 'B', phone: event.phone, content: { text: 'Olá!' }, actor: 'session-router:admin:link' })
    expect(deps.finish).toHaveBeenCalledWith('link', 'wa-1', { messageId: 'outbound' })
  })

  it.each([
    { ...link, enabled: false },
    { ...link, sourceSessionId: 'C' },
    { ...link, targetSessionId: 'A' },
    { ...link, rules: { matchText: 'outro', replyText: 'Olá!' } },
  ])('não dispara vínculo desativado, origem errada, autorreferência ou regra diferente', async (entry) => {
    const { deps, router } = setup({ links: async () => [entry] })
    expect(await router.route(event)).toBe(0)
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('ignora contas gerenciadas, impedindo ciclos mesmo com A -> B e B -> A', async () => {
    const { deps, router } = setup({ isManagedPhone: async () => true })
    expect(await router.route(event)).toBe(0)
    expect(deps.claim).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('respeita ausência de consentimento/opt-out', async () => {
    const { deps, router } = setup({ contactAllowed: async () => false })
    expect(await router.route(event)).toBe(0)
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('uma reivindicação compartilhada bloqueia duplicatas concorrentes e após recriar o router', async () => {
    const { deps, router } = setup()
    await Promise.all([router.route(event), router.route(event), new SessionRouter(deps).route(event)])
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it('falha de B é registrada e não impede regra para C', async () => {
    const send = vi.fn().mockRejectedValueOnce({ code: 'SESSION_NOT_CONNECTED' }).mockResolvedValueOnce({ id: 'out-C' })
    const { deps, router } = setup({ links: async () => [link, { ...link, id: 'link-C', targetSessionId: 'C' }], send })
    expect(await router.route(event)).toBe(1)
    expect(deps.finish).toHaveBeenCalledWith('link', event.inboundId, { error: 'SESSION_NOT_CONNECTED' })
    expect(deps.finish).toHaveBeenCalledWith('link-C', event.inboundId, { messageId: 'out-C' })
    await router.route(event)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('relê vínculos a cada mensagem e observa desativação', async () => {
    let enabled = true
    const { deps, router } = setup({ links: async () => [{ ...link, enabled }] })
    await router.route(event)
    enabled = false
    await router.route({ ...event, inboundId: 'wa-2' })
    expect(deps.send).toHaveBeenCalledTimes(1)
  })
})
