import { describe, expect, it } from 'vitest'
import { FakeTransport } from '../transport'
import type { SessionState } from '../session/states'
import { SessionError } from '../session/store'
import { listGroups, listSessionGroups, SessionNotConnectedError, toGroupView } from './index'

const GROUPS = [
  { id: 'b@g.us', name: 'Beta', participants: 3, announce: true },
  { id: 'a@g.us', name: 'Alpha', participants: 10, announce: false, communityId: 'c@g.us' },
]

function connected() {
  const t = new FakeTransport()
  t.setGroups(GROUPS)
  t.open()
  return t
}

const storeWith = (status: SessionState) => ({
  get: async (id: string) => {
    if (id !== 's1') throw new SessionError('SESSION_NOT_FOUND', 'nope')
    return { id, status }
  },
})

describe('grupos', () => {
  it('toGroupView mapeia status a partir de announce', () => {
    expect(toGroupView(GROUPS[0]!)).toEqual({ id: 'b@g.us', name: 'Beta', participants: 3, status: 'announce', announce: true, communityId: null, isAdmin: false })
    expect(toGroupView(GROUPS[1]!)).toMatchObject({ status: 'open', communityId: 'c@g.us' })
  })

  it('listGroups ordena por nome', async () => {
    expect((await listGroups(connected())).map((g) => g.name)).toEqual(['Alpha', 'Beta'])
  })

  it('transporte desconectado → SessionNotConnectedError', async () => {
    const t = new FakeTransport()
    t.setGroups(GROUPS)
    const err = await listGroups(t, 's1').catch((e) => e)
    expect(err).toBeInstanceOf(SessionNotConnectedError)
    expect(err.code).toBe('SESSION_NOT_CONNECTED')
  })

  it('listSessionGroups exige WARMING/STABLE/DEGRADED e transporte vivo', async () => {
    const t = connected()
    const getTransport = () => t
    for (const status of ['WARMING', 'STABLE', 'DEGRADED'] as const) {
      expect(await listSessionGroups({ store: storeWith(status), sessionId: 's1', getTransport })).toHaveLength(2)
    }
    for (const status of ['NEW', 'PAUSED', 'DISCONNECTED'] as const) {
      await expect(listSessionGroups({ store: storeWith(status), sessionId: 's1', getTransport })).rejects.toBeInstanceOf(SessionNotConnectedError)
    }
    await expect(listSessionGroups({ store: storeWith('STABLE'), sessionId: 's1' })).rejects.toBeInstanceOf(SessionNotConnectedError)
    await expect(listSessionGroups({ store: storeWith('STABLE'), sessionId: 'x', getTransport })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })
})
