import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AiAttachment } from '../ai/attach'

const mocks = vi.hoisted(() => ({ optout: vi.fn(async () => ({ handled: false })) }))
vi.mock('../optout', () => ({ createOptOutHandler: () => mocks.optout }))
function setup(consumed: boolean) {
  const assistant = { suggest: vi.fn(async () => ({ text: 'resposta', model: 'small' })) }
  const consumeConversation = vi.fn(async () => consumed)
  const routeIncoming = vi.fn(async () => 0)
  const attachment = new AiAttachment(new EventEmitter(), { db: {} as never, assistant: assistant as never, consumeConversation, routeIncoming, logger: { info() {}, warn() {}, error() {} } })
  const record = vi.spyOn(attachment.suggestions, 'recordInbound').mockResolvedValue({ created: true, message: { id: 'in', phone: '+5511999990000', text: 'oi' } } as never)
  const create = vi.spyOn(attachment.suggestions, 'create').mockResolvedValue({ id: 'suggestion' } as never)
  const incoming = { id: 'wa', from: '5511999990000@s.whatsapp.net', text: 'oi', fromMe: false, timestamp: Date.now(), type: 'text' } as never
  return { attachment, assistant, consumeConversation, routeIncoming, record, create, incoming }
}
describe('inbound de conversa interna', () => {
  it('persiste antes de consumir e não gera uma segunda resposta ou sugestão', async () => {
    const s = setup(true)
    expect(await s.attachment.handleIncoming('b', s.incoming)).toEqual({ kind: 'ignored', reason: 'conversation' })
    expect(s.record).toHaveBeenCalledTimes(1)
    expect(s.record.mock.invocationCallOrder[0]!).toBeLessThan(s.consumeConversation.mock.invocationCallOrder[0]!)
    expect(s.consumeConversation).toHaveBeenCalledWith('b', '+5511999990000', 'oi')
    expect(s.routeIncoming).not.toHaveBeenCalled(); expect(s.assistant.suggest).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled()
    s.attachment.stop()
  })
  it('mantém mensagens de clientes no fluxo assistivo existente', async () => {
    const s = setup(false)
    expect(await s.attachment.handleIncoming('b', s.incoming)).toMatchObject({ kind: 'suggested' })
    expect(s.assistant.suggest).toHaveBeenCalledWith('oi'); expect(s.create).toHaveBeenCalledTimes(1)
    s.attachment.stop()
  })
})
