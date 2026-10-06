import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_GROUP_AUTOMATION, FakeTransport, SendRejectedError, type GroupAutomationConfig, type GroupAutomationState, type SessionView } from '@wsm/core'
import { GroupAutomation } from './automation'
import type { GroupAutomationStore } from './store'

const DAY = 86_400_000
const CODE = 'ABCDEFGHIJKLMNOPQRSTUV'
const group = { id: 'one@g.us', name: 'Jogos', participants: 50, announce: false }
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
  const model = {
    discover: vi.fn(async () => [{ inviteUrl: `https://chat.whatsapp.com/${CODE}`, topic: 'jogos' }]),
    judge: vi.fn(async (_group: { name: string; description?: string; topic: string }) => true),
    message: vi.fn(async () => 'Qual jogo vocês estão curtindo hoje?'),
  }
  const sendGroup = vi.fn(async () => ({ id: 'daily-1' }))
  const messages = { get: vi.fn(async () => ({ status: 'sent', sentAt: new Date(now - DAY).toISOString() })) }
  const invites = { run: vi.fn(async () => ({ result: 'joined' })) }
  const audit = vi.fn(async () => undefined)
  const options = { manager, store, model, pipeline: { sendGroup } as never, limits: limits as never, messages: messages as never, invites: invites as never, audit, logger: { warn: vi.fn() }, now: () => now, random: () => 0 }
  const service = new GroupAutomation(options)
  return { service, options, a, b, configs, states, sessions, model, sendGroup, messages, invites, inspect, accept, leases, limits,
    advance: (ms: number) => { now += ms }, level: (n: number) => { day = n } }
}

describe('entrada automática e mensagem diária', () => {
  it('busca grupo público, inspeciona, entra e enfileira mensagem sobre o tema', async () => {
    const s = setup()
    await s.service.run('a')
    expect(s.accept).toHaveBeenCalledWith(CODE)
    expect(s.model.message).toHaveBeenCalledWith('Jogos', expect.stringContaining('Bate-papo sobre jogos'), undefined, [])
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
  it('chip sem proxy repassa e o chip com proxy entra; quem repassa segue fora do grupo', async () => {
    const s = setup()
    s.sessions.set('a', { ...s.sessions.get('a')!, proxyId: null })
    s.configs.set('b', { ...DEFAULT_GROUP_AUTOMATION, enabled: true })
    await s.service.run('a')
    expect(s.states.get('b')?.groups[0]).toMatchObject({ id: group.id, state: 'joined', forwardedTo: 'a' })
    expect(s.states.get('a')?.groups[0]).toMatchObject({ id: group.id, state: 'pending', forwardedTo: 'b' })
    expect(s.accept).not.toHaveBeenCalled()
    expect(s.sendGroup).not.toHaveBeenCalled()
  })
  it('chip sem proxy não pesquisa nem consulta convites quando não há chip com proxy para receber', async () => {
    for (const reason of ['sem-proxy', 'desativado', 'desconectado']) {
      const s = setup()
      s.sessions.set('a', { ...s.sessions.get('a')!, proxyId: null })
      s.configs.set('b', { ...DEFAULT_GROUP_AUTOMATION, enabled: reason !== 'desativado' })
      if (reason === 'sem-proxy') s.sessions.set('b', { ...s.sessions.get('b')!, proxyId: null })
      if (reason === 'desconectado') s.sessions.get('b')!.status = 'DISCONNECTED'
      await s.service.run('a')
      expect(s.model.discover, reason).not.toHaveBeenCalled()
      expect(s.inspect, reason).not.toHaveBeenCalled()
      expect(s.invites.run, reason).not.toHaveBeenCalled()
    }
  })
  it('chip sem proxy respeita o teto de 24 h e não acumula grupos aguardando repasse', async () => {
    const other = 'ZYXWVUTSRQPONMLKJIHGFE'
    const candidates = [
      { inviteUrl: `https://chat.whatsapp.com/${CODE}`, topic: 'jogos' },
      { inviteUrl: `https://chat.whatsapp.com/${other}`, topic: 'tecnologia' },
    ]
    const inspect = async (code: string) => ({ ...group, id: code === CODE ? 'one@g.us' : 'two@g.us', description: 'tema' })
    const s = setup()
    s.sessions.set('a', { ...s.sessions.get('a')!, proxyId: null })
    s.configs.set('a', { ...DEFAULT_GROUP_AUTOMATION, enabled: true, maxEntriesPerDay: 1 })
    s.configs.set('b', { ...DEFAULT_GROUP_AUTOMATION, enabled: true })
    s.model.discover.mockResolvedValue(candidates)
    s.inspect.mockImplementation(inspect)
    await s.service.run('a')
    s.advance(60_000)
    await s.service.run('a')
    expect(s.inspect).toHaveBeenCalledTimes(1) // teto 1 por 24 h
    s.advance(DAY)
    await s.service.run('a')
    expect(s.inspect).toHaveBeenCalledTimes(2) // janela de 24 h renovada

    const t = setup() // B sem vaga: o grupo descoberto fica aguardando e nada novo é consultado
    t.model.discover.mockResolvedValue(candidates)
    t.inspect.mockImplementation(inspect)
    t.sessions.set('a', { ...t.sessions.get('a')!, proxyId: null })
    t.configs.set('b', { ...DEFAULT_GROUP_AUTOMATION, enabled: true })
    t.states.set('b', { groups: [], entryTimes: [Date.parse('2026-10-02T11:00:00Z')] })
    await t.service.run('a')
    t.advance(60_000)
    await t.service.run('a')
    expect(t.inspect).toHaveBeenCalledTimes(1)
    expect(t.states.get('a')?.groups.filter((g) => !g.forwardedTo)).toHaveLength(1)
  })
  it('mensagem diária sai num horário sorteado entre 9 h e 21 h, diferente a cada dia', async () => {
    const s = setup() // 12:00Z = 09:00 em Brasília
    let r = 0.5
    const service = new GroupAutomation({ ...s.options, random: () => r })
    await service.run('a')
    expect(s.accept).toHaveBeenCalledTimes(1)
    expect(s.sendGroup).not.toHaveBeenCalled() // sorteou 15:00 (metade da janela)
    expect(s.states.get('a')?.groups[0]?.postAt).toEqual({ day: '2026-10-02', at: Date.parse('2026-10-02T18:00:00Z') })
    s.advance(6 * 3_600_000 - 60_000)
    await service.run('a')
    expect(s.sendGroup).not.toHaveBeenCalled()
    s.advance(60_000)
    await service.run('a')
    expect(s.sendGroup).toHaveBeenCalledTimes(1)
    r = 0.25
    s.advance(18 * 3_600_000) // dia seguinte, 09:00: novo sorteio (12:00 em Brasília)
    await service.run('a')
    expect(s.states.get('a')?.groups[0]?.postAt).toEqual({ day: '2026-10-03', at: Date.parse('2026-10-03T15:00:00Z') })
    expect(s.sendGroup).toHaveBeenCalledTimes(1)
  })
  it('antes de postar lê as últimas mensagens do grupo e passa à IA; a própria postagem entra no histórico', async () => {
    const s = setup()
    const recent = [{ author: 'Ana', text: 'alguém jogando o lançamento novo?', at: 1 }]
    const history = { recent: vi.fn(async () => recent), record: vi.fn(async () => undefined) }
    const service = new GroupAutomation({ ...s.options, random: () => 0, history })
    await service.run('a')
    expect(history.recent).toHaveBeenCalledWith('a', group.id)
    expect(s.model.message).toHaveBeenCalledWith('Jogos', expect.any(String), undefined, recent)
    expect(history.record).toHaveBeenCalledWith('a', group.id, expect.objectContaining({ text: 'Qual jogo vocês estão curtindo hoje?', fromMe: true }))
    // Falha ao ler o histórico não impede a postagem (usa só o tema).
    const t = setup()
    const broken = { recent: vi.fn(async () => { throw new Error('redis fora') }), record: vi.fn(async () => undefined) }
    await new GroupAutomation({ ...t.options, random: () => 0, history: broken }).run('a')
    expect(t.model.message).toHaveBeenCalledWith('Jogos', expect.any(String), undefined, [])
    expect(t.sendGroup).toHaveBeenCalledTimes(1)
  })
  it('grupo repetido na lista (repasse + entrada própria) posta uma vez só no dia', async () => {
    const s = setup()
    s.a.setGroups([group])
    const dup = { id: group.id, name: group.name, topic: 'tema', inviteCode: CODE, joinedAt: Date.parse('2026-10-02T11:00:00Z'), state: 'joined' as const }
    s.states.set('a', { groups: [dup, { ...dup, forwardedTo: 'b' }], entryTimes: [Date.parse('2026-10-02T11:00:00Z')] })
    await new GroupAutomation({ ...s.options, random: () => 0 }).run('a')
    expect(s.sendGroup).toHaveBeenCalledTimes(1)
    expect(s.states.get('a')!.groups.filter((g) => g.id === group.id)).toHaveLength(1)
  })
  it('envio atrasado (recusado pelo limite) não sai depois das 21 h', async () => {
    const s = setup()
    const service = new GroupAutomation({ ...s.options, random: () => 0.99 }) // sorteia ~20:52
    s.sendGroup.mockRejectedValue(new SendRejectedError('RATE_LIMIT', 'wait'))
    await service.run('a')
    s.advance(12 * 3_600_000 - 5 * 60_000) // 20:55: tenta e é recusado
    await service.run('a')
    expect(s.sendGroup).toHaveBeenCalledTimes(1)
    s.sendGroup.mockResolvedValue({ id: 'daily-1' })
    s.advance(10 * 60_000) // 21:05: limite liberou, mas já passou da janela
    await service.run('a')
    expect(s.sendGroup).toHaveBeenCalledTimes(1)
  })
  it('depois das 21 h a mensagem do dia fica para amanhã', async () => {
    const s = setup()
    s.advance(12.5 * 3_600_000) // 21:30 em Brasília
    await s.service.run('a')
    expect(s.accept).toHaveBeenCalledTimes(1)
    expect(s.sendGroup).not.toHaveBeenCalled()
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
  it('juiz reprova spam: não entra nem repassa, e o convite sai do cache', async () => {
    const s = setup()
    s.model.judge.mockResolvedValue(false)
    await s.service.run('a')
    expect(s.model.judge).toHaveBeenCalledWith({ name: 'Jogos', description: 'Bate-papo sobre jogos', topic: 'jogos' })
    expect(s.accept).not.toHaveBeenCalled()
    expect(s.states.get('a')?.discovery?.candidates).toEqual([])
    expect(s.states.get('a')?.rejectedAt).toBeDefined()

    const t = setup()
    t.sessions.set('a', { ...t.sessions.get('a')!, proxyId: null })
    t.configs.set('b', { ...DEFAULT_GROUP_AUTOMATION, enabled: true })
    t.model.judge.mockResolvedValue(false)
    await t.service.run('a')
    expect(t.invites.run).not.toHaveBeenCalled()
    expect(t.states.get('a')?.groups).toEqual([])
  })
  it('tamanho fora de 20 a 900 participantes é descartado sem chamar o juiz', async () => {
    for (const participants of [5, 2000]) {
      const s = setup()
      s.inspect.mockResolvedValue({ ...group, participants, description: 'jogos' })
      await s.service.run('a')
      expect(s.model.judge, String(participants)).not.toHaveBeenCalled()
      expect(s.accept, String(participants)).not.toHaveBeenCalled()
    }
  })
  it('convite expirado é descartado sem marcar erro, e o resto do ciclo segue', async () => {
    const s = setup()
    s.a.setGroups([group])
    s.states.set('a', { groups: [{ id: group.id, name: 'Jogos', topic: 'jogos', inviteCode: 'OLD', joinedAt: 0, state: 'joined' }] })
    s.model.discover.mockResolvedValue([{ inviteUrl: `https://chat.whatsapp.com/${'X'.repeat(22)}`, topic: 'jogos' }])
    s.inspect.mockRejectedValue(new Error('not-authorized'))
    await s.service.run('a')
    expect(s.states.get('a')?.lastError).toBeUndefined()
    expect(s.sendGroup).toHaveBeenCalledTimes(1) // mensagem diária do grupo existente não é afetada
  })
  it('depois de um descarte espera 15 min, e consulta no máximo 8 convites em 24 h', async () => {
    const s = setup()
    s.level(10)
    s.model.discover.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ inviteUrl: `https://chat.whatsapp.com/${String(i).padStart(22, 'A')}`, topic: 'jogos' })))
    s.model.judge.mockResolvedValue(false)
    await s.service.run('a')
    s.advance(60_000)
    await s.service.run('a')
    expect(s.inspect).toHaveBeenCalledTimes(1) // em pausa após o descarte
    for (let i = 0; i < 20; i++) { s.advance(16 * 60_000); await s.service.run('a') }
    expect(s.inspect).toHaveBeenCalledTimes(8)
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

// Simulação (fuzz) da automação de grupos: chips com e sem proxy, worker morrendo no meio, quedas, convites inválidos,
// falhas da IA, da fila e do aceite — conferindo invariantes a cada passo. SIM_SEEDS=N roda mais cenários.
describe('simulação da automação de grupos', () => {
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  function mulberry32(seed: number) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  class Crash extends Error { constructor() { super('processo morreu'); this.name = 'Crash' } }

  interface Faults { crash: number; restart: number; disconnect: number; inspect: number; accept: number; invite: number; discover: number; message: number; reject: number }
  const NO_FAULTS: Faults = { crash: 0, restart: 0, disconnect: 0, inspect: 0, accept: 0, invite: 0, discover: 0, message: 0, reject: 0 }

  function world(seed: number) {
    const rand = mulberry32(seed)
    let faults = { ...NO_FAULTS }
    let now = Date.parse('2026-10-03T03:00:00Z') // 00:00 em Brasília
    const level = Math.floor(rand() * 4) // dia de warm-up
    const ids = ['P1', 'P2', 'N1', 'N2'] // P = com proxy, N = sem proxy
    const sessions = new Map(ids.map((id, i) => [id, { id, status: 'WARMING', phone: `+55119999${i}000`, proxyId: id.startsWith('P') ? `proxy-${id}` : null } as SessionView]))
    const configs = new Map<string, GroupAutomationConfig>(ids.map((id) => [id, { ...DEFAULT_GROUP_AUTOMATION, enabled: rand() < 0.9, maxEntriesPerDay: 1 + Math.floor(rand() * 5) }]))
    const states = new Map<string, GroupAutomationState>()
    const leases = new Map<string, { token: string; until: number }>()
    const connected = new Set(ids)
    const offlineUntil = new Map<string, number>()
    const transports = new Map<string, FakeTransport>()
    const pool = Array.from({ length: 40 }, (_, i) => ({ code: `CODE${String(i).padStart(18, '0')}`, id: `g${i}@g.us`, announce: rand() < 0.2 }))
    const log = {
      accepts: [] as Array<{ at: number; session: string; group: string }>,
      forwards: [] as Array<{ at: number; from: string; to: string; group: string }>,
      posts: [] as Array<{ at: number; session: string; group: string }>,
      discovers: [] as Array<{ at: number; session: string; proxiedTargets: number }>,
      crashes: 0, violations: [] as string[],
    }
    const msgs = new Map<string, { status: string; sentAt: string }>()
    let gen = 0
    let msgSeq = 0

    for (const id of ids) {
      const t = new FakeTransport(); t.open()
      Object.assign(t, {
        inspectGroupInvite: async (code: string) => {
          if (rand() < faults.inspect) throw new Error('convite inválido')
          const g = pool.find((p) => p.code === code)!
          return { id: g.id, name: `Grupo ${g.id}`, participants: 50, announce: g.announce, description: 'tema' }
        },
        groupAcceptInvite: async (code: string) => {
          if (rand() < faults.accept) throw new Error('aceite falhou')
          const g = pool.find((p) => p.code === code)!
          log.accepts.push({ at: now, session: id, group: g.id })
          if (!t.groups.some((x) => x.id === g.id)) t.setGroups([...t.groups, { id: g.id, name: `Grupo ${g.id}`, participants: 51, announce: g.announce, isAdmin: false }])
          return g.id
        },
      })
      transports.set(id, t)
    }
    const proxiedTargets = (except: string) => ids.filter((x) => x !== except && x.startsWith('P') && connected.has(x) && configs.get(x)!.enabled).length

    function instance() {
      const myGen = gen
      const alive = () => myGen === gen
      const maybeCrash = () => {
        if (alive() && rand() < faults.crash) { gen++; log.crashes++ }
        if (!alive()) throw new Crash()
      }
      const store: GroupAutomationStore = {
        config: async (id) => structuredClone(configs.get(id) ?? DEFAULT_GROUP_AUTOMATION),
        saveConfig: async (id, v) => { maybeCrash(); configs.set(id, structuredClone(v)) },
        state: async (id) => structuredClone(states.get(id) ?? { groups: [] }),
        saveState: async (id, v) => { maybeCrash(); states.set(id, structuredClone(v)) },
        remove: async (id) => { configs.delete(id); states.delete(id) },
        claim: async (key, ttl) => {
          const l = leases.get(key)
          if (!alive() || (l && l.until > now)) return undefined
          const token = `${myGen}-${rand()}`; leases.set(key, { token, until: now + ttl }); return token
        },
        renew: async (key, token, ttl) => { const l = leases.get(key); if (alive() && l?.token === token) l.until = now + ttl },
        release: async (key, token) => { if (alive() && leases.get(key)?.token === token) leases.delete(key) },
      }
      const manager = {
        list: async () => [...sessions.values()], get: async (id: string) => sessions.get(id)!,
        getTransport: (id: string) => (connected.has(id) ? transports.get(id) : undefined), isConnected: (id: string) => connected.has(id),
      }
      const model = {
        discover: async () => {
          maybeCrash()
          const caller = (new Error().stack ?? '') && current.caller
          log.discovers.push({ at: now, session: caller, proxiedTargets: proxiedTargets(caller) })
          if (rand() < faults.discover) throw new Error('busca falhou')
          return Array.from({ length: 8 }, () => pool[Math.floor(rand() * pool.length)]!).map((g) => ({ inviteUrl: `https://chat.whatsapp.com/${g.code}`, topic: 'jogos' }))
        },
        judge: async () => { maybeCrash(); return rand() >= faults.reject },
        message: async () => { maybeCrash(); if (rand() < faults.message) throw new Error('IA falhou'); return `msg ${++msgSeq}` },
      }
      const pipeline = {
        sendGroup: async (input: { sessionId: string; groupId: string }) => {
          maybeCrash()
          if (rand() < faults.reject) throw Object.assign(new Error('gate'), { name: 'SendRejectedError' })
          const id = `m${++msgSeq}`
          msgs.set(id, { status: 'sent', sentAt: new Date(now).toISOString() })
          log.posts.push({ at: now, session: input.sessionId, group: input.groupId })
          return { id }
        },
      }
      const invites = {
        run: async (input: { sourceSessionId: string; targetSessionId: string }, pub: { groupId: string; code: string }) => {
          maybeCrash()
          if (rand() < faults.invite) throw new Error('convite não recebido')
          log.forwards.push({ at: now, from: input.sourceSessionId, to: input.targetSessionId, group: pub.groupId })
          const t = transports.get(input.targetSessionId)!
          const g = pool.find((p) => p.id === pub.groupId)!
          if (!t.groups.some((x) => x.id === g.id)) t.setGroups([...t.groups, { id: g.id, name: `Grupo ${g.id}`, participants: 51, announce: g.announce, isAdmin: false }])
          return { groupId: g.id, targetSessionId: input.targetSessionId, messageId: 'x', result: 'joined' }
        },
      }
      const limits = {
        get: async () => ({ effective: { perMinute: 5, perHour: 50, perDay: 30, factor: 1 }, warmup: { day: level } }),
        countOutbound: async (id: string, since: Date) => log.posts.filter((p) => p.session === id && p.at > since.getTime()).length,
      }
      const messages = { get: async (id: string) => msgs.get(id) ?? { status: 'sent', sentAt: new Date(now).toISOString() } }
      const service = new GroupAutomation({
        manager: manager as never, store, limits: limits as never, pipeline: pipeline as never, messages: messages as never,
        model, invites: invites as never, audit: async () => undefined, logger: { warn: () => undefined }, now: () => now, random: rand,
      })
      return { service, alive }
    }
    let current = { ...instance(), caller: '' }
    const restart = () => { gen++; current = { ...instance(), caller: '' } }

    const spHour = (at: number) => new Date(at - 3 * HOUR).getUTCHours()
    const spDay = (at: number) => new Date(at - 3 * HOUR).toISOString().slice(0, 10)
    function check(where: string) {
      const v = log.violations
      for (const a of log.accepts) if (!a.session.startsWith('P')) v.push(`${where}: ${a.session} sem proxy entrou em ${a.group}`)
      for (const f of log.forwards) if (!f.to.startsWith('P')) v.push(`${where}: repassou para ${f.to} sem proxy`)
      for (const p of log.posts) {
        if (!p.session.startsWith('P')) v.push(`${where}: ${p.session} sem proxy postou`)
        if (spHour(p.at) < 9 || spHour(p.at) >= 21) v.push(`${where}: post fora da janela às ${spHour(p.at)}h`)
      }
      const perDay = new Map<string, number>()
      for (const p of log.posts) { const k = `${p.session}|${p.group}|${spDay(p.at)}`; perDay.set(k, (perDay.get(k) ?? 0) + 1) }
      for (const [k, n] of perDay) if (n > 1) v.push(`${where}: ${n} posts no mesmo dia ${k}`)
      for (const id of ids) {
        const cap = Math.max(0, Math.min(configs.get(id)!.maxEntriesPerDay, 30, level + 1))
        const entries = [...log.accepts.filter((a) => a.session === id).map((a) => a.at), ...log.forwards.filter((f) => f.to === id).map((f) => f.at)].sort((a, b) => a - b)
        for (const at of entries) {
          const n = entries.filter((x) => x > at - DAY && x <= at).length
          if (n > cap) { v.push(`${where}: ${id} entrou ${n}x em 24 h (teto ${cap})`); break }
        }
        const discovers = log.discovers.filter((d) => d.session === id)
        for (const d of discovers) {
          if (discovers.filter((x) => x.at > d.at - DAY && x.at <= d.at).length > 1) { v.push(`${where}: ${id} pesquisou mais de 1x em 24 h`); break }
          if (id.startsWith('N') && d.proxiedTargets === 0) v.push(`${where}: ${id} sem proxy pesquisou sem ninguém para receber`)
        }
      }
    }

    async function step() {
      now += MINUTE
      for (const id of ids) {
        if (offlineUntil.has(id) && offlineUntil.get(id)! <= now) { offlineUntil.delete(id); connected.add(id) }
        else if (connected.has(id) && rand() < faults.disconnect) { connected.delete(id); offlineUntil.set(id, now + Math.floor(rand() * 30) * MINUTE) }
      }
      if (rand() < faults.restart) restart()
      // Como o tickAll: um ciclo por conta, em paralelo. Rodamos em sequência para atribuir a pesquisa à conta certa.
      for (const id of ids) {
        current.caller = id
        try { await current.service.run(id) } catch (err) { if (!(err instanceof Crash)) log.violations.push(`exceção não tratada em ${id}: ${String(err)}`) }
        if (!current.alive()) restart()
      }
    }
    return {
      log, states, configs, transports,
      setFaults: (f: Partial<Faults>) => { faults = { ...NO_FAULTS, ...f } },
      run: async (steps: number, where: string) => { for (let i = 0; i < steps; i++) { await step(); check(`${where}#${i}`); if (log.violations.length) return } },
    }
  }

  const SEEDS = Number(process.env.SIM_SEEDS ?? 3)


    it(`sem falhas: só chip com proxy entra/posta, limites e horários respeitados (${SEEDS} seeds)`, async () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const w = world(seed)
        await w.run(2 * 24 * 60, `seed ${seed}`)
        expect(w.log.violations, `seed ${seed}`).toEqual([])
      }
    }, 600_000)
    it(`com falhas e reinícios: invariantes continuam valendo (${SEEDS} seeds)`, async () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const w = world(50_000 + seed)
        w.setFaults({ crash: 0.01, restart: 0.005, disconnect: 0.005, inspect: 0.1, accept: 0.1, invite: 0.1, discover: 0.1, message: 0.1, reject: 0.1 })
        await w.run(2 * 24 * 60, `seed ${50_000 + seed} caos`)
        expect(w.log.violations, `seed ${50_000 + seed}`).toEqual([])
      }
    }, 600_000)
    it(`chips com proxy e vaga acabam entrando e postando (${SEEDS} seeds)`, async () => {
      const parados: string[] = []
      for (let seed = 1; seed <= SEEDS; seed++) {
        const w = world(90_000 + seed)
        for (const id of ['P1', 'P2']) w.configs.set(id, { ...w.configs.get(id)!, enabled: true })
        await w.run(2 * 24 * 60, `seed ${90_000 + seed}`)
        expect(w.log.violations, `seed ${90_000 + seed}`).toEqual([])
        for (const id of ['P1', 'P2']) {
          if (!w.log.accepts.some((a) => a.session === id) && !w.log.forwards.some((f) => f.to === id)) parados.push(`seed ${90_000 + seed}: ${id} nunca entrou`)
          else if (!w.log.posts.some((p) => p.session === id)) {
            // Grupo só-admins não aceita mensagem: não postar nele é o correto.
            const abertos = w.transports.get(id)!.groups.filter((g) => !g.announce)
            if (abertos.length) parados.push(`seed ${90_000 + seed}: ${id} entrou em ${abertos.length} grupo(s) aberto(s) mas nunca postou`)
          }
        }
      }
      expect(parados).toEqual([])
    }, 600_000)
})
