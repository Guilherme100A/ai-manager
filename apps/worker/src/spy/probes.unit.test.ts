import { describe, expect, it, vi } from 'vitest'
import { ProbeAiDisabledError, SendRejectedError, type ProbeDecision, type SpyProbeRow, type SpyProbeStore } from '@wsm/core'
import { mergeSummary, openerLanguage, SpyProbeRunner } from './probes'

const T0 = Date.parse('2026-10-20T12:00:00Z')

function probe(over: Partial<SpyProbeRow> = {}): SpyProbeRow {
  return {
    id: 'p1', offerId: 'o1', sessionId: 's1', phone: '+5584920022034', branch: 'principal', status: 'ativa', turns: 0, maxTurns: 12,
    replyDueAt: new Date(T0), lastInboundAt: null, lastOutboundAt: null, listenUntil: null, summary: {}, endedReason: null,
    createdBy: 'admin', startedAt: new Date(T0 - 60_000), endedAt: null, updatedAt: new Date(T0), ...over,
  }
}

function setup(opts: { row?: SpyProbeRow; history?: Array<{ de: 'eu' | 'oferta'; texto: string }>; decision?: ProbeDecision | Error; latest?: Date; allowed?: boolean; status?: string; send?: () => Promise<{ id: string }> } = {}) {
  let row = opts.row ?? probe()
  const store = {
    active: vi.fn(async () => (row.status === 'ativa' ? [row] : [])),
    due: vi.fn(async () => (row.status === 'ativa' && row.replyDueAt && row.replyDueAt.getTime() <= T0 ? [row] : [])),
    latestInbound: vi.fn(async () => opts.latest),
    inboundSeen: vi.fn(async (_id: string, at: Date, delay: number) => { row = { ...row, lastInboundAt: at, replyDueAt: new Date(T0 + delay) } }),
    history: vi.fn(async () => (opts.history ?? []).map((t) => ({ ...t, at: new Date(T0) }))),
    replied: vi.fn(async () => { row = { ...row, replyDueAt: null } }),
    postpone: vi.fn(async () => undefined),
    end: vi.fn(async (_id: string, status: SpyProbeRow['status']) => { row = { ...row, status } }),
    listening: vi.fn(async (sessionId: string, phone: string) => (sessionId === 's1' && phone === row.phone ? row : undefined)),
  }
  const sent: Array<Record<string, unknown>> = []
  const pipeline = { send: vi.fn(async (req: Record<string, unknown>) => { sent.push(req); return (opts.send ? opts.send() : { id: `m${sent.length}` }) as never }) }
  const model = { decide: vi.fn(async () => { if (opts.decision instanceof Error) throw opts.decision; return opts.decision! }) }
  const typing = vi.fn(async () => undefined)
  const runner = new SpyProbeRunner({
    store: store as unknown as SpyProbeStore, model, pipeline: pipeline as never,
    messages: { get: vi.fn(async () => ({ sentAt: new Date(T0).toISOString(), status: 'sent' })) as never },
    manager: { get: async () => ({ status: opts.status ?? 'STABLE' }) as never, getTransport: () => ({ sendTyping: typing }) },
    allowed: async () => opts.allowed ?? true,
    offerContext: async () => ({ pagina: 'Chef Maria', anuncio: 'Receitas sem açúcar para você vender' }),
    logger: { info: vi.fn(), warn: vi.fn() }, now: () => T0, random: () => 0, sleep: async () => undefined,
  })
  return { runner, store, sent, model, typing, get row() { return row } }
}

const decision = (over: Partial<ProbeDecision>): ProbeDecision => ({ acao: 'responder', mensagens: [], checkout: [], opcoes: [], humano: false, ...over })

describe('SpyProbeRunner', () => {
  it('sem mensagem nossa ainda: manda a abertura (digitando + origin spy), sem chamar a IA', async () => {
    const s = setup()
    await s.runner.tick()
    expect(s.typing).toHaveBeenCalled()
    expect(s.sent).toEqual([{ sessionId: 's1', phone: '+5584920022034', content: { text: 'Oi! Vi o anúncio de vocês e fiquei interessada, como funciona?' }, actor: 'spy-probe', origin: 'spy' }])
    expect(s.model.decide).not.toHaveBeenCalled()
    expect(s.store.replied).toHaveBeenCalledWith('p1', { turns: 1, sentAt: new Date(T0) })
  })

  it('mensagem nova da oferta: agenda a resposta com atraso humano (40 s a 150 s)', async () => {
    const s = setup({ row: probe({ replyDueAt: null, turns: 1 }), latest: new Date(T0 - 1_000) })
    await s.runner.tick()
    expect(s.store.inboundSeen).toHaveBeenCalledWith('p1', new Date(T0 - 1_000), 40_000)
    expect(s.sent).toHaveLength(0) // ainda não venceu
  })

  it('responde com a IA (até 2 mensagens), conta o turno e guarda preço, checkout e links', async () => {
    const s = setup({
      row: probe({ turns: 1 }),
      history: [{ de: 'eu', texto: 'Oi' }, { de: 'oferta', texto: 'Custa R$ 47. Link: https://pay.kiwify.com/abc' }],
      decision: decision({ mensagens: ['Ah legal', 'aceita pix?'], preco: 'R$ 47', etapa: 'oferta' }),
    })
    await s.runner.tick()
    expect(s.sent.map((r) => (r.content as { text: string }).text)).toEqual(['Ah legal', 'aceita pix?'])
    expect(s.model.decide).toHaveBeenCalledWith([{ de: 'eu', texto: 'Oi' }, { de: 'oferta', texto: 'Custa R$ 47. Link: https://pay.kiwify.com/abc' }], expect.objectContaining({ turnosRestantes: 11, pagina: 'Chef Maria' }))
    expect(s.store.replied).toHaveBeenCalledWith('p1', expect.objectContaining({ turns: 2, summary: expect.objectContaining({ preco: 'R$ 47', links: ['https://pay.kiwify.com/abc'] }) }))
  })

  it('IA encerra (checkout capturado): conclui e continua ouvindo (sem mandar nada)', async () => {
    const s = setup({ row: probe({ turns: 3 }), history: [{ de: 'eu', texto: 'oi' }], decision: decision({ acao: 'encerrar', checkout: ['https://pay.x/1'], motivo: 'checkout capturado' }) })
    await s.runner.tick()
    expect(s.sent).toHaveLength(0)
    expect(s.store.end).toHaveBeenCalledWith('p1', 'concluida', 'checkout capturado', { summary: expect.objectContaining({ checkout: ['https://pay.x/1'] }) })
  })

  it('opt-out para a sonda sem ouvir mais; IA sem chave vira erro; limite do chip adia', async () => {
    const optOut = setup({ allowed: false })
    await optOut.runner.tick()
    expect(optOut.store.end).toHaveBeenCalledWith('p1', 'parada', 'o número pediu para sair (opt-out)', { listen: false })

    const noKey = setup({ row: probe({ turns: 1 }), history: [{ de: 'eu', texto: 'oi' }], decision: new ProbeAiDisabledError() })
    await noKey.runner.tick()
    expect(noKey.store.end).toHaveBeenCalledWith('p1', 'erro', expect.stringContaining('chave'), { listen: false })

    const limited = setup({ send: async () => { throw new SendRejectedError('RATE_LIMIT', 'limite') } })
    await limited.runner.tick()
    expect(limited.store.postpone).toHaveBeenCalledWith('p1', 15 * 60_000)

    const offline = setup({ status: 'DISCONNECTED' })
    await offline.runner.tick()
    expect(offline.store.postpone).toHaveBeenCalledWith('p1', 10 * 60_000)
    expect(offline.sent).toHaveLength(0)
  })

  it('limite de turnos encerra; oferta muda 24 h encerra; mensagens do número da sonda são dela', async () => {
    const last = setup({ row: probe({ turns: 11 }), history: [{ de: 'eu', texto: 'oi' }], decision: decision({ mensagens: ['ok'] }) })
    await last.runner.tick()
    expect(last.store.end).toHaveBeenCalledWith('p1', 'concluida', 'limite de 12 respostas', expect.anything())

    const silent = setup({ row: probe({ turns: 2, replyDueAt: null, lastOutboundAt: new Date(T0 - 25 * 3_600_000) }) })
    await silent.runner.tick()
    expect(silent.store.end).toHaveBeenCalledWith('p1', 'concluida', 'a oferta parou de responder por 24 h')

    const s = setup()
    expect(await s.runner.handlesInbound('s1', '+5584920022034')).toBe(true)
    expect(await s.runner.handlesInbound('s1', '+5511000000000')).toBe(false)
  })
})

describe('auxiliares', () => {
  it('idioma da abertura pelo texto do anúncio', () => {
    expect(openerLanguage('Recetas saludables para tu familia, más de 100 opciones')).toBe('es')
    expect(openerLanguage('Receitas que você pode vender em casa')).toBe('pt')
    expect(openerLanguage(undefined)).toBe('pt')
  })

  it('mergeSummary junta checkout e links sem repetir', () => {
    const merged = mergeSummary({ checkout: ['a'], links: ['https://x.com/1'] }, { checkout: ['a', 'b'], opcoes: [], humano: true, preco: 'R$ 10' }, ['veja https://x.com/1 e https://y.com/2'])
    expect(merged).toMatchObject({ checkout: ['a', 'b'], links: ['https://x.com/1', 'https://y.com/2'], humano: true, preco: 'R$ 10' })
  })
})

describe('estratégia da ramificação', () => {
  it('objeção e sumiu mandam a estratégia para a IA; principal não', async () => {
    for (const [branch, expected] of [['objecao', /achou caro/], ['sumiu', /encerre/], ['principal', undefined]] as const) {
      const s = setup({ row: probe({ turns: 1, branch }), history: [{ de: 'eu', texto: 'oi' }], decision: decision({ acao: 'esperar' }) })
      await s.runner.tick()
      const ctx = (s.model.decide.mock.calls[0] as unknown as [unknown, { estrategia?: string }])[1]
      if (expected) expect(ctx.estrategia).toMatch(expected)
      else expect(ctx.estrategia).toBeUndefined()
    }
  })
})
