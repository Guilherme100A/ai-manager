import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeTransport } from '../transport/fake'
import { GroupInviteService, type GroupInviteInput } from './invites'

const input: GroupInviteInput = { sourceSessionId: 'a', targetSessionId: 'b', groupIds: ['one@g.us', 'two@g.us'], actor: 'admin' }
const link = 'https://chat.whatsapp.com/TEST_CODE'
function setup() {
  const a = new FakeTransport()
  const b = new FakeTransport()
  a.open()
  b.open()
  a.setGroups([
    { id: 'one@g.us', name: 'One', participants: 1, announce: false, isAdmin: true },
    { id: 'two@g.us', name: 'Two', participants: 1, announce: false, isAdmin: true },
  ])
  let chosen = ''
  const code = vi.fn(async (id: string) => { chosen = id; return 'TEST_CODE' })
  const accept = vi.fn(async () => {
    b.setGroups([{ id: chosen, name: 'Joined', participants: 2, announce: false }])
    return chosen
  })
  Object.assign(a, { groupInviteCode: code })
  Object.assign(b, { groupAcceptInvite: accept })
  const transports = new Map([['a', a], ['b', b]])
  const get = vi.fn(async (id: string) => ({ id, status: 'STABLE', phone: id === 'a' ? '+5511111111111' : '+5522222222222' }))
  const send = vi.fn(async () => {
    b.receive({ from: '5511111111111@s.whatsapp.net', text: link })
    return { id: 'message-1' }
  })
  const audit = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const service = new GroupInviteService({
    sessions: { get } as never, getTransport: (id) => transports.get(id),
    pipeline: { send } as never, audit, cancelMessage: cancel, receiptTimeoutMs: 5,
  })
  return { a, b, code, accept, send, audit, cancel, service, get, transports }
}
afterEach(() => vi.restoreAllMocks())

describe('convite entre sessões', () => {
  it('sorteia somente do pool e aceita após B receber de A; envia pelo pipeline e remove listener', async () => {
    const s = setup()
    const out = await s.service.run({ ...input, groupIds: ['two@g.us'] })
    expect(out).toEqual({ groupId: 'two@g.us', targetSessionId: 'b', messageId: 'message-1', result: 'joined' })
    expect(s.send).toHaveBeenCalledWith({ sessionId: 'a', phone: '+5522222222222', actor: 'admin', content: { text: link } })
    expect(s.accept).toHaveBeenCalledWith('TEST_CODE')
    expect(s.audit).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(s.audit.mock.calls)).not.toContain('TEST_CODE')
    expect(s.b.listenerCount('message')).toBe(0)
  })
  it('exclui grupos onde B já é membro e onde A não é admin', async () => {
    const s = setup()
    s.b.setGroups([{ id: 'one@g.us', name: 'One', participants: 1, announce: false }])
    await expect(s.service.run(input)).resolves.toMatchObject({ groupId: 'two@g.us' })
    const t = setup()
    t.a.groups.forEach((g) => { g.isAdmin = false })
    await expect(t.service.run(input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(t.send).not.toHaveBeenCalled()
  })
  it.each(['unknown@g.us', 'already@g.us'])('não envia sem grupo elegível: %s', async (id) => {
    const s = setup()
    await expect(s.service.run({ ...input, groupIds: [id] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(s.code).not.toHaveBeenCalled()
  })
  it('não aceita um link diferente ou recebido de outra conta ou grupo', async () => {
    const s = setup()
    s.send.mockImplementation(async () => {
      s.b.receive({ from: 'someone@s.whatsapp.net', text: link })
      s.b.receive({ from: 'one@g.us', text: link })
      s.b.receive({ from: '5511111111111@s.whatsapp.net', text: `${link}OTHER` })
      s.b.receive({ from: '5511111111111@s.whatsapp.net', text: link, fromMe: true })
      return { id: 'message-1' }
    })
    await expect(s.service.run(input)).rejects.toMatchObject({ code: 'GROUP_INVITE_FAILED' })
    expect(s.accept).not.toHaveBeenCalled()
    expect(s.cancel).toHaveBeenCalledWith('message-1')
    expect(s.b.listenerCount('message')).toBe(0)
  })
  it('identifica A pelo telefone alternativo quando o chat usa LID', async () => {
    const s = setup()
    s.send.mockImplementation(async () => {
      s.b.receive({ from: '123@lid', fromAlt: '5511111111111:3@s.whatsapp.net', text: link })
      return { id: 'message-1' }
    })
    await expect(s.service.run(input)).resolves.toMatchObject({ result: 'joined' })
  })
  it('preserva rejeições do pipeline e limpa listener', async () => {
    const s = setup()
    s.send.mockRejectedValue(Object.assign(new Error('contact blocked'), { code: 'CONTACT_NOT_ALLOWED' }))
    await expect(s.service.run(input)).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED' })
    expect(s.accept).not.toHaveBeenCalled()
    expect(s.b.listenerCount('message')).toBe(0)
  })
  it('bloqueia mesma sessão e sessão desconectada', async () => {
    const s = setup()
    await expect(s.service.run({ ...input, targetSessionId: 'a' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    s.transports.delete('b')
    await expect(s.service.run(input)).rejects.toMatchObject({ code: 'SESSION_NOT_CONNECTED' })
    expect(s.send).not.toHaveBeenCalled()
  })
  it('bloqueia fluxos concorrentes e aplica cooldown após uma tentativa', async () => {
    const s = setup()
    const first = s.service.run(input)
    await expect(s.service.run(input)).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    await first
    await expect(s.service.run(input)).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })
  it('não afirma entrada concluída sem confirmação na lista de grupos', async () => {
    const s = setup()
    s.accept.mockImplementation(async () => undefined as never)
    await expect(s.service.run(input)).resolves.toMatchObject({ result: 'awaiting_confirmation' })
  })
  it('não aceita quando o transporte de B foi substituído durante o envio', async () => {
    const s = setup()
    s.send.mockImplementation(async () => {
      s.b.receive({ from: '5511111111111@s.whatsapp.net', text: link })
      s.transports.set('b', new FakeTransport())
      return { id: 'message-1' }
    })
    await expect(s.service.run(input)).rejects.toMatchObject({ code: 'SESSION_NOT_CONNECTED' })
    expect(s.accept).not.toHaveBeenCalled()
  })
  it('não aceita quando uma sessão foi pausada enquanto aguardava o recebimento', async () => {
    const s = setup()
    s.send.mockImplementation(async () => {
      s.b.receive({ from: '5511111111111@s.whatsapp.net', text: link })
      s.get.mockImplementation(async (id) => ({ id, status: 'PAUSED', phone: '+5511111111111' }))
      return { id: 'message-1' }
    })
    await expect(s.service.run(input)).rejects.toMatchObject({ code: 'SESSION_NOT_CONNECTED' })
    expect(s.accept).not.toHaveBeenCalled()
  })
})
