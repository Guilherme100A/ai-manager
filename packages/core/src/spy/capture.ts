import { asc, eq, inArray, or, sql } from 'drizzle-orm'
import { spyAds, type Database, type SpyAdData } from '@wsm/db'
import { canonicalSpyCaptureUrl, SpyCaptureError } from './capture-url'
import { classifyInput } from './parse'

const terminal = (status: string) => !['na_fila', 'lendo'].includes(status)
const item = (row: typeof spyAds.$inferSelect) => ({
  capture_id: row.id, status: row.status, offer_id: row.offerId,
  attempts: row.attempts, retry_at: row.retryAt?.toISOString() ?? null,
  reason: row.status === 'erro' ? 'capture_failed' : row.status === 'sem_numero' ? 'phone_not_found' : row.retryAt ? 'retry_scheduled' : null,
})

/** Durable, capture-only intents; independent from probe creation and chip selection. */
export class SpyCaptureStore {
  constructor(private readonly db: Database) {}

  async register(url: string, createdBy: string, seed: { parentId?: string; data?: SpyAdData } = {}) {
    const canonical = canonicalSpyCaptureUrl(url), input = classifyInput(canonical)
    const archive = input.kind === 'ad' ? input.adArchiveId : null
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('spy:manual-capture'), hashtext(${canonical}))`)
      const find = () => tx.select().from(spyAds).where(or(eq(spyAds.inputUrl, canonical), archive ? eq(spyAds.adArchiveId, archive) : undefined)).orderBy(asc(spyAds.createdAt)).limit(1)
      const [existing] = await find()
      if (existing) {
        if (existing.data.captureOnly !== true) throw new SpyCaptureError('LEGACY_CAPTURE')
        return { row: existing, created: false }
      }
      const [row] = await tx.insert(spyAds).values({ inputUrl: canonical, adArchiveId: archive, createdBy,
        parentId: seed.parentId, data: { ...seed.data, captureOnly: true } }).onConflictDoNothing().returning()
      if (row) return { row, created: true }
      const [raced] = await find()
      if (!raced || raced.data.captureOnly !== true) throw new SpyCaptureError('LEGACY_CAPTURE')
      return { row: raced, created: false }
    })
  }

  async get(id: string) {
    const [row] = await this.db.select().from(spyAds).where(eq(spyAds.id, id))
    if (!row) throw new SpyCaptureError('NOT_FOUND')
    if (row.data.captureOnly !== true) throw new SpyCaptureError('LEGACY_CAPTURE')
    const ids = (row.data.captureChildren ?? []).filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    const children = ids.length ? (await this.db.select().from(spyAds).where(inArray(spyAds.id, ids)).orderBy(asc(spyAds.createdAt), asc(spyAds.id))).filter(c => c.data.captureOnly === true) : []
    const offers = [...new Set([row.offerId, ...children.map(c => c.offerId)].filter((id): id is string => Boolean(id)))].sort()
    const finished = terminal(row.status) && children.every(c => terminal(c.status))
    return { ...item(row), offer_id: offers.length === 1 && (row.status !== 'expandido' || finished) ? offers[0]! : null, offer_ids: offers,
      capture_only: true, manual_start_required: true, requires_offer_choice: offers.length > 1,
      finished, children: children.map(item),
      skipped_existing: row.data.captureSkipped ?? 0 }
  }
}
