import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActivityLog } from './activity'
import { startStallMonitor } from './stall-monitor'

describe('registro de atividade', () => {
  it('resume só a janela pedida, maiores primeiro', () => {
    let t = 0
    const log = createActivityLog(() => t)
    for (const [at, label] of [[100, 'msg:a:grupo'], [200, 'msg:a:grupo'], [250, 'grupos:ciclo'], [900, 'msg:b:direto']] as const) {
      t = at
      log.mark(label)
    }
    expect(log.summary(150, 300)).toEqual({ 'msg:a:grupo': 1, 'grupos:ciclo': 1 })
    expect(Object.keys(log.summary(0, 1000))).toEqual(['msg:a:grupo', 'grupos:ciclo', 'msg:b:direto'])
  })
  it('capacidade limitada: guarda só as mais recentes', () => {
    let t = 0
    const log = createActivityLog(() => t, 3)
    for (let i = 0; i < 5; i++) { t = i; log.mark(`x${i}`) }
    expect(log.summary(0, 10)).toEqual({ x2: 1, x3: 1, x4: 1 })
  })
})

describe('modo alívio após travamento', () => {
  afterEach(() => vi.useRealTimers())

  it('travamento grava o resumo de atividade e liga o modo alívio por um tempo', () => {
    vi.useFakeTimers()
    let t = 0
    const inserted: unknown[] = []
    const db = { insert: () => ({ values: (v: unknown) => { inserted.push(v); return Promise.resolve() } }) }
    const activity = createActivityLog(() => t)
    const m = startStallMonitor({ db: db as never, logger: { warn() {} }, activity, tickMs: 250, thresholdMs: 1000, pressureMs: 60_000, now: () => t })
    expect(m.underPressure()).toBe(false)
    t = 250
    vi.advanceTimersByTime(250)
    expect(inserted).toHaveLength(0)
    t = 300
    activity.mark('msg:chip1:grupo')
    t = 2000 // o loop ficou parado: o próximo tick chega 1,5 s atrasado
    vi.advanceTimersByTime(250)
    expect(inserted).toEqual([expect.objectContaining({ action: 'worker.stall', detail: expect.objectContaining({ lagMs: 1500, activity: { 'msg:chip1:grupo': 1 } }) })])
    expect(m.underPressure()).toBe(true)
    t = 62_001
    expect(m.underPressure()).toBe(false)
    m.stop()
  })
})
