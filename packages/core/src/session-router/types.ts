import type { SessionLinkRules } from '@wsm/db'
export type { SessionLinkRules }

export interface SessionLink {
  id: string
  sourceSessionId: string
  targetSessionId: string
  enabled: boolean
  rules: SessionLinkRules
  createdBy: string
}

export interface RouteEvent {
  sessionId: string
  inboundId: string
  phone: string
  text: string
}

export interface RouterDependencies {
  links(sourceSessionId: string): Promise<SessionLink[]>
  isManagedPhone(phone: string): Promise<boolean>
  contactAllowed(phone: string): Promise<boolean>
  claim(linkId: string, inboundId: string): Promise<boolean>
  finish(linkId: string, inboundId: string, result: { messageId?: string; error?: string }): Promise<void>
  send(request: { sessionId: string; phone: string; content: { text: string }; actor: string }): Promise<{ id: string }>
}
