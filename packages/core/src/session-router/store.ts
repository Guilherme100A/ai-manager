import { and, desc, eq } from 'drizzle-orm'
import { contacts, sessionLinks, sessionRouteRuns, sessions, type Database } from '@wsm/db'
import { canMessage } from '../contacts/policy'
import type { RouterDependencies, SessionLink } from './types'

export class SessionLinkStore {
  constructor(private readonly db: Database) {}

  list() { return this.db.select().from(sessionLinks).orderBy(desc(sessionLinks.createdAt)) }
  async create(input: Omit<SessionLink, 'id'>) {
    const [row] = await this.db.insert(sessionLinks).values(input).returning()
    return row!
  }
  async setEnabled(id: string, enabled: boolean) {
    const [row] = await this.db.update(sessionLinks).set({ enabled }).where(eq(sessionLinks.id, id)).returning()
    return row
  }
  async remove(id: string) {
    const rows = await this.db.delete(sessionLinks).where(eq(sessionLinks.id, id)).returning({ id: sessionLinks.id })
    return rows.length > 0
  }
  runs() { return this.db.select().from(sessionRouteRuns).orderBy(desc(sessionRouteRuns.createdAt)).limit(100) }

  dependencies(send: RouterDependencies['send']): RouterDependencies {
    return {
      send,
      links: (sourceSessionId) => this.db.select().from(sessionLinks).where(and(eq(sessionLinks.sourceSessionId, sourceSessionId), eq(sessionLinks.enabled, true))),
      isManagedPhone: async (phone) => (await this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.phone, phone)).limit(1)).length > 0,
      contactAllowed: async (phone) => canMessage((await this.db.select().from(contacts).where(eq(contacts.phone, phone)).limit(1))[0]).ok,
      claim: async (linkId, inboundId) => (await this.db.insert(sessionRouteRuns).values({ linkId, inboundId }).onConflictDoNothing().returning()).length > 0,
      finish: async (linkId, inboundId, result) => {
        await this.db.update(sessionRouteRuns).set({
          status: result.error ? 'failed' : 'queued', messageId: result.messageId ?? null, error: result.error ?? null,
        }).where(and(eq(sessionRouteRuns.linkId, linkId), eq(sessionRouteRuns.inboundId, inboundId)))
      },
    }
  }
}
