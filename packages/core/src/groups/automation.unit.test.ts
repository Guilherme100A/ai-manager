import { describe, expect, it } from 'vitest'
import { automationDay, groupEntryCapacity, inviteCodeFromUrl } from './automation'
const view = {
  effective: { perMinute: 5, perHour: 100, perDay: 20, warmupDailyLimit: 20, factor: 1 },
  warmup: { day: 0, percent: 0, complete: false, dailyLimit: 20, dayStartedAt: null },
}
describe('limite de entradas por nível', () => {
  it('dia inicial admite uma entrada; dias seguintes aumentam até o teto configurado', () => {
    expect(groupEntryCapacity(view, 0, 5)).toMatchObject({ dailyEntryLimit: 1, remainingEntries: 1, canEnter: true })
    expect(groupEntryCapacity(view, 1, 5).canEnter).toBe(false)
    expect(groupEntryCapacity({ ...view, warmup: { ...view.warmup, day: 2 } }, 1, 5)).toMatchObject({ dailyEntryLimit: 3, remainingEntries: 2 })
    expect(groupEntryCapacity({ ...view, warmup: { ...view.warmup, day: 20 } }, 1, 5).dailyEntryLimit).toBe(5)
  })
  it('redução de saúde reduz entradas, sem usar volume de mensagens dos grupos', () => {
    const higher = { ...view, warmup: { ...view.warmup, day: 3 }, effective: { ...view.effective, factor: 0.5 } }
    expect(groupEntryCapacity(higher, 0, 5).dailyEntryLimit).toBe(2)
    expect(groupEntryCapacity({ ...view, effective: { ...view.effective, perDay: 0 } }, 0, 5).canEnter).toBe(false)
  })
  it('aceita somente códigos extraídos do domínio oficial HTTPS', () => {
    expect(inviteCodeFromUrl('https://chat.whatsapp.com/ABCDEFGHIJKLMNOPQRSTUV?mode=gi_t')).toBe('ABCDEFGHIJKLMNOPQRSTUV')
    for (const value of ['http://chat.whatsapp.com/ABCDEFGHIJKLMNOPQRSTUV', 'https://evil.com/ABCDEFGHIJKLMNOPQRSTUV', 'https://chat.whatsapp.com.evil.com/ABCDEFGHIJKLMNOPQRSTUV', 'https://user@chat.whatsapp.com/ABCDEFGHIJKLMNOPQRSTUV', 'https://chat.whatsapp.com/abc/def', 'https://chat.whatsapp.com/tiny']) expect(inviteCodeFromUrl(value)).toBeUndefined()
  })
  it('o dia diário considera São Paulo', () => {
    expect(automationDay(Date.parse('2026-10-03T01:00:00Z'))).toBe('2026-10-02')
    expect(automationDay(Date.parse('2026-10-03T04:00:00Z'))).toBe('2026-10-03')
  })
})
