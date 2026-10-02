import type { SessionLinkRules } from './types'

export function matchesRule(rules: SessionLinkRules, text: string): boolean {
  const normalize = (value: string) => value.trim().normalize('NFC').toLocaleLowerCase('pt-BR')
  return Boolean(rules.matchText.trim() && rules.replyText.trim()) && normalize(rules.matchText) === normalize(text)
}
