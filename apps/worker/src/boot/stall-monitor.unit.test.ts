import { describe, expect, it } from 'vitest'
import { createStallDetector } from './stall-monitor'

describe('detector de travamento do worker', () => {
  it('ticks no ritmo normal ou com atraso pequeno não contam', () => {
    const tick = createStallDetector({ tickMs: 250, thresholdMs: 1000, start: 0 })
    expect(tick(250)).toBeUndefined()
    expect(tick(520)).toBeUndefined() // 20 ms de atraso
    expect(tick(1500)).toBeUndefined() // 730 ms
  })
  it('loop parado por mais de 1 s devolve o atraso', () => {
    const tick = createStallDetector({ tickMs: 250, thresholdMs: 1000, start: 0 })
    expect(tick(250)).toBeUndefined()
    expect(tick(2000)).toBe(1500)
    expect(tick(2250)).toBeUndefined() // voltou ao normal
  })
})
