import { matchesRule } from './rules'
import type { RouteEvent, RouterDependencies } from './types'

/** Central routing. Only fresh external inbound events enter; outgoing messages never recurse here. */
export class SessionRouter {
  constructor(private readonly deps: RouterDependencies) {}

  async route(event: RouteEvent): Promise<number> {
    if (!event.inboundId || !event.text.trim()) return 0
    const links = await this.deps.links(event.sessionId)
    if (!links.length) return 0
    // A message from any managed account is a terminal hop, including A -> B -> A graphs.
    if (await this.deps.isManagedPhone(event.phone)) return 0
    if (!(await this.deps.contactAllowed(event.phone))) return 0
    let queued = 0
    for (const link of links) {
      if (!link.enabled || link.sourceSessionId !== event.sessionId || link.sourceSessionId === link.targetSessionId) continue
      if (!matchesRule(link.rules, event.text)) continue
      if (!(await this.deps.claim(link.id, event.inboundId))) continue
      try {
        const message = await this.deps.send({
          sessionId: link.targetSessionId,
          phone: event.phone,
          content: { text: link.rules.replyText },
          actor: `session-router:${link.createdBy}:${link.id}`,
        })
        await this.deps.finish(link.id, event.inboundId, { messageId: message.id })
        queued++
      } catch (err) {
        const code = (err as { code?: unknown })?.code
        await this.deps.finish(link.id, event.inboundId, { error: typeof code === 'string' ? code : 'ROUTE_FAILED' })
      }
    }
    return queued
  }
}
