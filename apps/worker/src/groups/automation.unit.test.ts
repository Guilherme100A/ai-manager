import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_GROUP_AUTOMATION, FakeTransport, SendRejectedError, type GroupAutomationConfig, type GroupAutomationState, type SessionView } from '@wsm/core'
import { GroupAutomation } from './automation'
import type { GroupAutomationStore } from './store'

const DAY = 86_400_000
const CODE = 'ABCDEFGHIJKLMNOPQRSTUV'
const group = { id: 'one@g.us', name: 'Jogos', participants: 10, announce: false }
function setup() {
  let now = Date.parse('2026-10-02T12:00:00Z')
  const configs = new Map<string, GroupAutomationConfig>([['a', { ...DEFAULT_GROUP_AUTOMATION, enabled: true }]])
  const states = new Map<string, GroupAutomationState>()
  const leases = new Set<string>()
  const store: GroupAutomationStore = {
    config: async (id) => structuredClone(configs.get(id) ?? DEFAULT_GROUP_AUTOMATION),
    saveConfig: async (id, value) => { configs.set(id, structuredClone(value)) },
    state: async (id) => structuredClone(states.get(id) ?? { groups: [] }),
    saveState: async (id, value) => { states.set(id, structuredClone(value)) },
    remove: async (id) => { configs.delete(id); states.delete(id) },
    claim: async (id) => { if (leases.has(id)) return undefined; leases.add(id); return 'token' },
    renew: async () => undefined,
    release: async (id) => { leases.delete(id) },
  }
  const a = new FakeTransport(); a.open()
  const b = new FakeTransport(); b.open()
  const inspect = vi.fn(async (_code: string) => ({ ...group, description: 'Bate-papo sobre jogos' }))
  const accept = vi.fn(async (_code: string) => { a.setGroups([...a.groups, group]); return group.id })
  Object.assign(a, { inspectGroupInvite: inspect, groupAcceptInvite: accept })
  const transports = new Map([['a', a], ['b', b]])
  const sessions = new Map(['a', 'b'].map((id) => [id, { id, status: 'WARMING', proxyId: `proxy-${id}`, phone: id === 'a' ? '+5511111111111' : '+5522222222222' } as SessionView]))
  const emitter = new EventEmitter()
  const manager = Object.assign(emitter, {
    list: async () => [...sessions.values()], get: async (id: string) => sessions.get(id)!,
    getTransport: (id: string) => transports.get(id), isConnected: (id: string) => !!transports.get(id),
  })
  let day = 0
  const limits = { get: vi.fn(async () => ({ effective: { perMinute: 5, perHour: 100, perDay: 20, factor: 1 }, warmup: { day } })), countOutbound: vi.fn(async () => 0) }
  const model = { discover: vi.fn(async () => [{ inviteUrl: `https://chat.whatsapp.com/${CODE}`, topic: 'jogos' }]), message: vi.fn(async () => 'Qual jogo vocês estão curtindo hoje?') }
  const sendGroup = vi.fn(async () => ({ id: 'daily-1' }))
  const messages = { get: vi.fn(async () => ({ status: 'sent', sentAt: new Date(now - DAY).toISOString() })) }
  const invites = { run: vi.fn(async () => ({ result: 'joined' })) }
  const audit = vi.fn(async () => undefined)
  const options = { manager, store, model, pipeline: { sendGroup } as never, limits: limits as never, messages: messages as never, invites: invites as never, audit, logger: { warn: vi.fn() }, now: () => now }
  const service = new GroupAutomation(options)
  return { service, options, a, b, configs, states, sessions, model, sendGroup, messages, invites, inspect, accept, leases, limits,
    advance: (ms: number) => { now += ms }, level: (n: number) => { day = n } }
}

describe('entrada automática e mensagem diária', () => {
  it('busca grupo público, inspeciona, entra e enfileira mensagem sobre o tema', async () => {
    const s = setup()
    await s.service.run('a')
    expect(s.accept).toHaveBeenCalledWith(CODE)
    expect(s.model.message).toHaveBeenCalledWith('Jogos', expect.stringContaining('Bate-papo sobre jogos'), undefined)
    expect(s.sendGroup).toHaveBeenCalledWith({ sessionId: 'a', groupId: group.id, content: { text: 'Qual jogo vocês estão curtindo hoje?' }, actor: 'group-automation' })
    expect(s.states.get('a')?.groups[0]?.state).toBe('joined')
    expect(s.leases.size).toBe(0)
  })
  it('chip sem proxy não entra nem posta no grupo: descobre o link e encaminha para um chip com proxy', async () => {
    const s = setup()
    s.sessions.set('a', { ...s.sessions.get('a')!, proxyId: null }) // chip "normal" sem IP
    s.configs.set('b', { ...DEFAULT_GROUP_AUTOMATION, enabled: true }) // B tem proxy e recebe a entrada
    await s.service.run('a')
    expect(s.accept).not.toHaveBeenCalled()    // nunca entra em grupo
    expect(s.sendGroup).not.toHaveBeenCalled() // nunca posta no grupo
    expect(s.model.discover).toHaveBeenCalled() // mas descobre o link público
    expect(s.invites.run).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'a', targetSessionId: 'b' }), { groupId: group.id, code: CODE })
  })
  it('não repete pesquisa ou mensagem no dia, inclusive após recriar o serviço', async () => {
    const s = setup()
    await s.service.run('a')
    await new GroupAutomation(s.options).run('a')
    expect(s.model.discover).toHaveBeenCalledTimes(1)
    expect(s.sendGroup).toHaveBeenCalledTimes(1)
    s.advance(DAY)
    await s.service.run('a')
    expect(s.model.message).toHaveBeenCalledTimes(2)
    expect(s.model.message.mock.calls[1]).toContain('Qual jogo vocês estão curtindo hoje?')
  })
  it('não pesquisa nem envia em conta desativada ou pausada', async () => {
    for (const reason of ['disabled', 'paused']) {
      const s = setup()
      if (reason === 'disabled') s.configs.set('a', { ...DEFAULT_GROUP_AUTOMATION })
      if (reason === 'paused') s.sessions.get('a')!.status = 'PAUSED'
      await s.service.run('a')
      expect(s.model.discover).not.toHaveBeenCalled()
      expect(s.sendGroup).not.toHaveBeenCalled()
    }
  })
  it('quantidade de grupos existentes não impede entrar: só o contador de entradas é limitado', async () => {
    const s = setup()
    s.a.setGroups(Array.from({ length: 10 }, (_, index) => ({ ...group, id: `existing-${index}@g.us` })))
    await s.service.run('a')
    expect(s.accept).toHaveBeenCalledTimes(1)
    expect((await s.service.view('a')).capacity).toMatchObject({ dailyEntryLimit: 1, usedEntries24h: 1, remainingEntries: 0 })
    expect((await s.service.view('a')).currentGroups).toBe(11)
  })
  it('contador em 24h impede novas entradas, sem bloquear a mensagem diária', async () => {
    const s = setup()
    await s.service.run('a')
    s.advance(60_000)
    await s.service.run('a')
    expect(s.model.discover).toHaveBeenCalledTimes(1)
    expect(s.accept).toHaveBeenCalledTimes(1)
  })
  it('nível 2 permite duas entradas no mesmo dia, sem esperar observação de tráfego', async () => {
    const s = setup()
    const other = 'ZYXWVUTSRQPONMLKJIHGFE'
    s.level(1)
    s.model.discover.mockResolvedValue([
      { inviteUrl: `https://chat.whatsapp.com/${CODE}`, topic: 'jogos' },
      { inviteUrl: `https://chat.whatsapp.com/${other}`, topic: 'tecnologia' },
    ])
    const id = (code: string) => code === CODE ? 'one@g.us' : 'two@g.us'
    s.inspect.mockImplementation(async (code: string) => ({ ...group, id: id(code), description: 'tema' }))
    s.accept.mockImplementation(async (code: string) => { s.a.setGroups([...s.a.groups, { ...group, id: id(code) }]); return id(code) })
    await s.service.run('a')
    await s.service.run('a')
    await s.service.run('a')
    expect(s.accept).toHaveBeenCalledTimes(2)
    expect(s.model.discover).toHaveBeenCalledTimes(1)
    expect((await s.service.view('a')).capacity).toMatchObject({ dailyEntryLimit: 2, usedEntries24h: 2, remainingEntries: 0 })
  })
  it('reutiliza o texto quando o pipeline rejeita e só agenda após limite liberar', async () => {
    const s = setup()
    s.sendGroup.mockRejectedValueOnce(new SendRejectedError('RATE_LIMIT', 'wait'))
    await s.service.run('a')
    await s.service.run('a')
    expect(s.model.message).toHaveBeenCalledTimes(1)
    expect(s.sendGroup).toHaveBeenCalledTimes(2)
  })
  it('não gera texto quando os limites de envio já foram consumidos', async () => {
    const s = setup()
    s.limits.countOutbound.mockResolvedValue(100)
    await s.service.run('a')
    expect(s.model.message).not.toHaveBeenCalled()
  })
  it('grupos somente-admins podem entrar, mas não enviam mensagem; domínio inválido não entra', async () => {
    const s = setup()
    s.inspect.mockResolvedValue({ ...group, announce: true, description: '' })
    s.accept.mockImplementation(async () => { s.a.setGroups([{ ...group, announce: true }]); return group.id })
    await s.service.run('a')
    expect(s.accept).toHaveBeenCalledTimes(1)
    expect(s.sendGroup).not.toHaveBeenCalled()
    const t = setup()
    t.model.discover.mockResolvedValue([{ inviteUrl: 'https://evil.com/code', topic: 'jogos' }])
    await t.service.run('a')
    expect(t.inspect).not.toHaveBeenCalled()
  })
  it('apenas um ciclo concorrente pode entrar e postar', async () => {
    const s = setup()
    await Promise.all([s.service.run('a'), s.service.run('a')])
    expect(s.accept).toHaveBeenCalledTimes(1)
    expect(s.sendGroup).toHaveBeenCalledTimes(1)
  })
  it('não encaminha convite para B sem capacidade ou com automação desativada', async () => {
    const s = setup()
    s.configs.set('b', { ...DEFAULT_GROUP_AUTOMATION, enabled: true })
    s.states.set('b', { groups: [], entryTimes: [Date.parse('2026-10-02T11:00:00Z')] })
    await s.service.run('a')
    expect(s.invites.run).not.toHaveBeenCalled()
  })
  it('encaminha convite público mesmo que A não seja admin, se B tiver capacidade', async () => {
    const s = setup()
    s.configs.set('b', { ...DEFAULT_GROUP_AUTOMATION, enabled: true })
    await s.service.run('a')
    expect(s.invites.run).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'a', targetSessionId: 'b' }), { groupId: group.id, code: CODE })
    expect(s.states.get('b')?.groups[0]?.state).toBe('joined')
  })
  it('mensagem pendente de ontem impede empilhar outra, e envio hoje conta para o dia atual', async () => {
    const s = setup()
    await s.service.run('a')
    s.advance(DAY)
    s.messages.get.mockResolvedValue({ status: 'queued', sentAt: '' })
    await s.service.run('a')
    expect(s.sendGroup).toHaveBeenCalledTimes(1)
    s.messages.get.mockResolvedValue({ status: 'sent', sentAt: '2026-10-03T12:00:00Z' })
    await s.service.run('a')
    expect(s.sendGroup).toHaveBeenCalledTimes(1)
  })
  it('encerra o timer e não lança novos ciclos após stop', async () => {
    const s = setup()
    s.configs.set('a', { ...DEFAULT_GROUP_AUTOMATION })
    await s.service.start()
    await s.service.stop()
    expect(s.service.requestTick('a')).toEqual({ queued: false })
    expect(s.model.discover).not.toHaveBeenCalled()
  })
})
