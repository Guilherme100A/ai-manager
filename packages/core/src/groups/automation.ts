import { randomInt } from 'node:crypto'
import type { SessionLimitsView } from '../safety/limits'

export interface GroupAutomationConfig {
  enabled: boolean
  query: string
  maxEntriesPerDay: number
  targetSessionId: string | null
}

export const DEFAULT_GROUP_AUTOMATION: GroupAutomationConfig = {
  enabled: false, query: 'jogos e tecnologia, grupos brasileiros', maxEntriesPerDay: 5, targetSessionId: null,
}

export interface ManagedGroup {
  id: string
  name: string
  topic: string
  inviteCode: string
  joinedAt: number
  state: 'pending' | 'joined'
  lastPostDay?: string
  draft?: { day: string; text: string }
  draftAttemptDay?: string
  lastMessageId?: string
  forwardedTo?: string
}
export interface GroupAutomationState {
  groups: ManagedGroup[]
  entryTimes?: number[]
  discovery?: { query: string; at: number; candidates: Array<{ inviteUrl: string; topic: string }> }
  lastSearchAt?: number
  lastJoinAt?: number
  lastError?: string
}

/** Limita somente entradas/tentativas por 24 h, usando o nível de warm-up e a redução de saúde existentes. */
export function groupEntryCapacity(view: Pick<SessionLimitsView, 'effective' | 'warmup'>, entriesLast24h: number, maxEntriesPerDay: number) {
  const level = Math.max(1, view.warmup.day + 1)
  const dailyEntryLimit = Math.max(0, Math.min(maxEntriesPerDay, view.effective.perDay, Math.floor(level * view.effective.factor)))
  const remainingEntries = Math.max(0, dailyEntryLimit - entriesLast24h)
  return { dailyEntryLimit, usedEntries24h: entriesLast24h, remainingEntries, canEnter: remainingEntries > 0 }
}

export function inviteCodeFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'chat.whatsapp.com' || url.username || url.password || url.port) return undefined
    const code = url.pathname.replace(/^\//, '').replace(/\/$/, '')
    return /^[A-Za-z0-9_-]{16,64}$/.test(code) ? code : undefined
  } catch { return undefined }
}

export function randomItem<T>(items: readonly T[]): T | undefined {
  return items.length ? items[randomInt(items.length)] : undefined
}

export function automationDay(now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
}

