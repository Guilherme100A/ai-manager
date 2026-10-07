import { describe, expect, it, vi } from 'vitest'
import {
  AntibanConfigError,
  antibanModeFromEnv,
  antibanPresetFromEnv,
  BaileysAntibanAdapter,
  contentFingerprint,
  createAntibanAdapter,
  defaultAntibanAdapter,
  PassthroughAntibanAdapter,
  resetDefaultAntibanAdapter,
  type AntiBanLike,
} from './adapter'

const TO = '5511999990001@s.whatsapp.net'

describe('configuração do antiban', () => {
  it('ANTIBAN_MODE: default real; só real|passthrough; inválido lança', () => {
    expect(antibanModeFromEnv({})).toBe('real')
    expect(antibanModeFromEnv({ ANTIBAN_MODE: '' })).toBe('real')
    // NODE_ENV/VITEST não influem
    expect(antibanModeFromEnv({ NODE_ENV: 'test', VITEST: 'true' })).toBe('real')
    expect(antibanModeFromEnv({ ANTIBAN_MODE: 'Passthrough' })).toBe('passthrough')
    expect(() => antibanModeFromEnv({ ANTIBAN_MODE: 'off' })).toThrow(AntibanConfigError)
  })

  it('ANTIBAN_PRESET: default conservative; inválido lança', () => {
    expect(antibanPresetFromEnv({})).toBe('conservative')
    expect(antibanPresetFromEnv({ ANTIBAN_PRESET: 'moderate' })).toBe('moderate')
    expect(() => antibanPresetFromEnv({ ANTIBAN_PRESET: 'yolo' })).toThrow(AntibanConfigError)
  })

  it('createAntibanAdapter respeita env e opções', () => {
    const warn = vi.fn()
    expect(createAntibanAdapter({ env: {} }).mode).toBe('real')
    const p = createAntibanAdapter({ env: { ANTIBAN_MODE: 'passthrough' }, logger: { warn } })
    expect(p.mode).toBe('passthrough')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![1]).toBe('antiban em passthrough')
    expect(createAntibanAdapter({ env: { ANTIBAN_MODE: 'passthrough' }, mode: 'real' }).mode).toBe('real')
  })

  it('defaultAntibanAdapter é singleton lido do ambiente', () => {
    resetDefaultAntibanAdapter()
    const a = defaultAntibanAdapter()
    expect(defaultAntibanAdapter()).toBe(a)
    // o vitest.config deste pacote liga passthrough explicitamente
    expect(a.mode).toBe(process.env.ANTIBAN_MODE === 'passthrough' ? 'passthrough' : 'real')
    resetDefaultAntibanAdapter()
    expect(defaultAntibanAdapter()).not.toBe(a)
    resetDefaultAntibanAdapter()
  })
})

describe('contentFingerprint', () => {
  it('texto, legenda e mídia', () => {
    expect(contentFingerprint({ text: 'oi' })).toBe('oi')
    expect(contentFingerprint({ image: { url: 'http://x/a.png' }, caption: 'c' })).toBe('[image:http://x/a.png]c')
    expect(contentFingerprint({ document: { url: 'u' }, mimetype: 'application/pdf' })).toBe('[document:u]')
  })
})

describe('PassthroughAntibanAdapter', () => {
  it('não espera nem bloqueia, mas conta', async () => {
    const a = new PassthroughAntibanAdapter({ warn() {} })
    for (let i = 0; i < 10; i++) expect(await a.beforeSend('s1', TO, { text: 'igual' })).toEqual({ allowed: true, delayMs: 0 })
    a.afterSend('s1', TO, { text: 'igual' }, 'm1')
    a.afterSendFailed('s1', 'x')
    expect(a.stats('s1')).toEqual({ before: 10, allowed: 10, blocked: 0, sent: 1, failed: 1 })
    expect(a.stats('s2')).toEqual({ before: 0, allowed: 0, blocked: 0, sent: 0, failed: 0 })
  })
})

describe('BaileysAntibanAdapter (real)', () => {
  it('uma instância do AntiBan por sessão, logging sempre desligado', async () => {
    const created: unknown[] = []
    const fake = (): AntiBanLike => ({
      beforeSend: vi.fn(async () => ({ allowed: true, delayMs: 1234 })),
      afterSend: vi.fn(),
      afterSendFailed: vi.fn(),
    })
    const warmUps: Array<{ graduated: boolean }> = []
    const a = new BaileysAntibanAdapter({ config: 'moderate', create: (cfg, w) => (created.push(cfg), warmUps.push(w), fake()) })
    expect(await a.beforeSend('s1', TO, { text: 'a' })).toEqual({ allowed: true, delayMs: 1234 })
    await a.beforeSend('s1', TO, { text: 'b' })
    await a.beforeSend('s2', TO, { text: 'a' })
    expect(created).toEqual([
      { preset: 'moderate', logging: false, inactivityThresholdHours: 1e9 },
      { preset: 'moderate', logging: false, inactivityThresholdHours: 1e9 },
    ])
    expect(warmUps.every((w) => w.graduated)).toBe(true)
  })

  it('o aquecimento do AntiBan não limita: o nosso (persistido) é o único limite diário', async () => {
    const a = new BaileysAntibanAdapter({ config: 'conservative' })
    // O conservative limitaria a 15 no "dia 1" do AntiBan, que reiniciava a cada restart do worker.
    for (let i = 0; i < 20; i++) {
      const d = await a.beforeSend('s1', `+55319000000${String(i).padStart(2, '0')}`, { text: `mensagem ${i}` })
      expect(d.reason ?? '', `envio ${i + 1}`).not.toMatch(/warm-?up/i)
      if (d.allowed) a.afterSend('s1', `+55319000000${String(i).padStart(2, '0')}`, { text: `mensagem ${i}` }, `m${i}`)
    }
  }, 30_000)

  it('com o baileys-antiban real: delays humanos e bloqueio de mensagens idênticas', async () => {
    const a = new BaileysAntibanAdapter({ config: 'conservative' })
    const decisions = []
    for (let i = 0; i < 4; i++) {
      const d = await a.beforeSend('s1', TO, { text: 'mesma mensagem' })
      decisions.push(d)
      if (d.allowed) a.afterSend('s1', TO, { text: 'mesma mensagem' }, `m${i}`)
    }
    expect(decisions.slice(0, 3).every((d) => d.allowed && d.delayMs > 0)).toBe(true)
    expect(decisions[3]!.allowed).toBe(false)
    expect(a.stats('s1')).toMatchObject({ before: 4, allowed: 3, blocked: 1, sent: 3 })
    // outra sessão tem estado próprio
    expect((await a.beforeSend('s2', TO, { text: 'mesma mensagem' })).allowed).toBe(true)
  })
})
