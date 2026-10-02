import { describe, expect, it, vi } from 'vitest'
import { FakeTransport } from '../transport/fake'
import { SendPipeline, SendRejectedError } from './pipeline'

function setup(announce = false, admin = false) {
  const transport = new FakeTransport(); transport.open()
  transport.setGroups([{ id: 'one@g.us', name: 'One', participants: 3, announce, isAdmin: admin }])
  const enqueue = vi.fn(async () => ({ id: 'queued-1' }))
  const gates = { auth: vi.fn(async () => undefined), sessionExists: vi.fn(async () => undefined),
    connected: async (_req: unknown, ctx: { transport?: unknown }) => { ctx.transport = transport },
    warmupLimit: vi.fn(async () => undefined), rateLimit: vi.fn(async () => undefined) }
  const pipeline = new SendPipeline({ db: {} as never, queue: { enqueue } as never, gates: gates as never })
  return { pipeline, enqueue, gates }
}
const input = { sessionId: 'a', groupId: 'one@g.us', content: { text: 'Qual jogo vocês curtem?' }, actor: 'group-automation' }
describe('envio em grupos passa pelo pipeline e pela fila', () => {
  it('enfileira com JID de grupo e mantém gates de warm-up e rate limit', async () => {
    const s = setup()
    await expect(s.pipeline.sendGroup(input)).resolves.toEqual({ id: 'queued-1' })
    expect(s.enqueue).toHaveBeenCalledWith({ sessionId: 'a', phone: 'one@g.us', content: input.content })
    expect(s.gates.warmupLimit).toHaveBeenCalledTimes(1)
    expect(s.gates.rateLimit).toHaveBeenCalledTimes(1)
  })
  it('grupo inexistente ou somente-admins impede envio; admin pode enviar', async () => {
    await expect(setup().pipeline.sendGroup({ ...input, groupId: 'unknown@g.us' })).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED' })
    await expect(setup(true).pipeline.sendGroup(input)).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED' })
    await expect(setup(true, true).pipeline.sendGroup(input)).resolves.toMatchObject({ id: 'queued-1' })
  })
  it('limite excedido não enfileira', async () => {
    const s = setup()
    s.gates.rateLimit.mockRejectedValue(new SendRejectedError('RATE_LIMIT', 'wait'))
    await expect(s.pipeline.sendGroup(input)).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(s.enqueue).not.toHaveBeenCalled()
  })
  it('destino individual ou JID inválido não pode usar a operação de grupo', async () => {
    await expect(setup().pipeline.sendGroup({ ...input, groupId: '5511@s.whatsapp.net' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
