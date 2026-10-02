import { describe, expect, it, vi } from 'vitest'
import { GroupInviteError, SendRejectedError } from '@wsm/core'
import { createApp } from '../app'
import { captureLogger, fakeDb, fakeRedis } from '../test-utils'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
function setup() {
  const { db, audits } = fakeDb()
  const runGroupInvite = vi.fn(async () => ({ groupId: 'one@g.us', targetSessionId: B, messageId: 'm', result: 'joined' }))
  const app = createApp({ db, redis: fakeRedis(), apiToken: 'token', logger: captureLogger().logger, sessions: { runGroupInvite } as never })
  const post = (body: unknown, authorized = true) => app.request(`/api/sessions/${A}/groups/invite-flow`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer token' } : {}) },
    body: JSON.stringify(body),
  })
  return { post, runGroupInvite, audits }
}
const body = { targetSessionId: B, groupIds: ['one@g.us'] }
describe('POST groups/invite-flow', () => {
  it('encaminha somente o pool explícito, A, B e o actor autenticado; audita o resultado', async () => {
    const s = setup()
    const res = await s.post(body)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: 'joined' })
    expect(s.runGroupInvite).toHaveBeenCalledWith({ ...body, sourceSessionId: A, actor: expect.any(String) })
    expect(s.audits[0]).toMatchObject({ action: 'group.invite.request', targetId: A })
  })
  it('exige autenticação e valida o pool sem disparar o worker', async () => {
    const s = setup()
    expect((await s.post(body, false)).status).toBe(401)
    for (const invalid of [{ ...body, groupIds: [] }, { ...body, groupIds: ['url'] }, { ...body, extra: true }, { ...body, targetSessionId: 'bad' }]) {
      expect((await s.post(invalid)).status).toBe(400)
    }
    expect(s.runGroupInvite).not.toHaveBeenCalled()
  })
  it.each([
    [new GroupInviteError('RATE_LIMIT', 'busy'), 429],
    [new GroupInviteError('SESSION_NOT_CONNECTED', 'offline'), 409],
    [new GroupInviteError('GROUP_INVITE_FAILED', 'not received'), 502],
    [new SendRejectedError('CONTACT_NOT_ALLOWED', 'blocked'), 403],
  ])('mapeia erros do fluxo e do envio', async (error, status) => {
    const s = setup()
    s.runGroupInvite.mockRejectedValue(error)
    const res = await s.post(body)
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ error: { code: error.code } })
  })
})
