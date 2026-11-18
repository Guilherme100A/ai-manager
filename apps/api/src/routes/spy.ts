// Espião de funil: links de anúncios entram na fila; o SpyRunner (server.ts) acha o WhatsApp de cada oferta.
import { Hono } from 'hono'
import { z } from 'zod'
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import { asc, desc, eq, or, inArray, isNotNull, sql } from 'drizzle-orm'
import { buildSpyFlow, mediaZipPath, renderBranchConversation, renderFlowPlaybook, renderFlowSummary, SENDABLE_STATES, SpyCaptureError, SpyCaptureStore, SpyProbeError, SpyProbeStore, SpyStore, normalizePhone, type SpyFlow } from '@wsm/core'
import { sessions, spyMedia, spyOffers, spyProbes, SPY_BRANCHES } from '@wsm/db'
import { ApiError, type ErrorCode } from '../errors'
import { setAudit } from '../middleware/audit'
import { loadSpyAutoProbeConfig, saveSpyAutoProbeConfig } from '../spy-auto'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'
import { parseSpyFlowZip } from '../spy-flow-import'

export const spyLinksSchema = z.object({
  links: z.array(z.string().trim().min(1).max(2048)).min(1).max(50),
}).strict()

const adParam = z.object({ id: z.uuid() })
const manualPhoneSchema = z.object({ phone: z.string().trim().min(8).max(40) }).strict()
const autoProbeSchema = z.object({ excludedSessionIds: z.array(z.uuid()).max(100) }).strict()
const editFlowSchema = z.object({
  title: z.string().trim().min(1).max(120),
  script: z.string().trim().min(1).max(100_000),
}).strict()

export function spyRoutes(deps: Pick<AppDeps, 'db' | 'redis'>) {
  const store = new SpyStore(deps.db)
  const probes = new SpyProbeStore(deps.db)
  const captures = new SpyCaptureStore(deps.db)
  return new Hono<AppEnv>()
    .get('/api/spy/ads', async (c) => c.json({ items: await store.listAds() }))
    .get('/api/spy/offers', async (c) => c.json({ items: await store.listOffers() }))
    .post('/api/spy/captures', validate('json', z.object({ url: z.string().trim().min(1).max(2048) }).strict()), async (c) => {
      try {
        const result = await captures.register(c.req.valid('json').url, c.get('actor'))
        setAudit(c, { action: 'spy.capture.create', targetType: 'spy_capture', targetId: result.row.id, detail: { created: result.created, capture_only: true } })
        return c.json({ ...await captures.get(result.row.id), created: result.created }, result.created ? 201 : 200)
      } catch (err) { throw captureError(err) }
    })
    .get('/api/spy/captures/:id', validate('param', adParam), async (c) => {
      try { return c.json(await captures.get(c.req.valid('param').id)) }
      catch (err) { throw captureError(err) }
    })
    .get('/api/spy/chips', async (c) => {
      const chips = await deps.db.select({
        session_id: sessions.id, name: sessions.name, phone: sessions.phone, status: sessions.status,
      }).from(sessions).orderBy(asc(sessions.name), asc(sessions.id))
      return c.json({ items: chips.map((chip) => ({ ...chip, sendable: SENDABLE_STATES.includes(chip.status) })) })
    })
    .get('/api/spy/media/:id', validate('param', adParam), async (c) => {
      const [file] = await deps.db.select().from(spyMedia).where(eq(spyMedia.id, c.req.valid('param').id)).limit(1)
      if (!file) throw new ApiError('NOT_FOUND', 'Mídia não encontrada')
      c.header('Content-Type', file.mime)
      c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName || file.id)}`)
      return c.body(new Uint8Array(file.bytes))
    })
    // Biblioteca: todo fluxo concluído/importado aparece aqui e pode ser aberto, editado e reutilizado.
    .get('/api/spy/flows', async (c) => {
      const items = await deps.db.select({
        id: spyOffers.id, phone: spyOffers.phone, pageName: spyOffers.pageName, status: spyOffers.status,
        title: spyOffers.flowTitle, source: spyOffers.flowSource, flowData: spyOffers.flowData, updatedAt: spyOffers.updatedAt,
        mediaCount: sql<number>`count(distinct ${spyMedia.id})::int`,
        branchCount: sql<number>`count(distinct ${spyProbes.id})::int`,
      }).from(spyOffers)
        .leftJoin(spyMedia, eq(spyMedia.offerId, spyOffers.id))
        .leftJoin(spyProbes, eq(spyProbes.offerId, spyOffers.id))
        .where(or(
        inArray(spyOffers.status, ['sondando', 'completa']),
        eq(spyOffers.flowSource, 'imported'), isNotNull(spyOffers.flowScript),
      )).groupBy(spyOffers.id).orderBy(desc(spyOffers.updatedAt))
      return c.json({ items: items.map(({ flowData, ...x }) => ({
        ...x, title: x.title ?? x.pageName ?? `Fluxo ${x.phone}`,
        branchCount: x.branchCount + (flowData?.conversations?.length ?? 0),
      })) })
    })
    .post('/api/spy/flows/import', async (c) => {
      const body = await c.req.parseBody()
      const file = body.file
      if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') throw new ApiError('VALIDATION_ERROR', 'Envie um arquivo ZIP do fluxo')
      if (file.size > 64 * 1024 * 1024) throw new ApiError('VALIDATION_ERROR', 'ZIP maior que 64 MB')
      let imported
      try {
        imported = await parseSpyFlowZip(await file.arrayBuffer(), file.name.replace(/\.zip$/i, ''))
      } catch (err) {
        throw new ApiError('VALIDATION_ERROR', (err as Error).message)
      }
      const phone = imported.phone ?? `importado-${randomUUID()}`
      const [existing] = await deps.db.select().from(spyOffers).where(eq(spyOffers.phone, phone)).limit(1)
      const values = {
        pageName: existing?.pageName ?? imported.title, status: 'completa', flowTitle: imported.title,
        flowScript: imported.script, flowSource: existing?.flowSource ?? 'imported' as const,
        flowData: { summary: imported.summary ?? undefined, conversations: imported.conversations }, updatedAt: new Date(),
      }
      const [offer] = existing
        ? await deps.db.update(spyOffers).set(values).where(eq(spyOffers.id, existing.id)).returning()
        : await deps.db.insert(spyOffers).values({ phone, ...values }).returning()
      const known = await deps.db.select({ fileName: spyMedia.fileName, mime: spyMedia.mime, size: spyMedia.size })
        .from(spyMedia).where(eq(spyMedia.offerId, offer!.id))
      const keys = new Set(known.map((m) => `${m.fileName}|${m.mime}|${m.size}`))
      let mediaAdded = 0
      for (const media of imported.media) {
        const key = `${media.fileName}|${media.mime}|${media.bytes.byteLength}`
        if (keys.has(key)) continue
        await deps.db.insert(spyMedia).values({
          offerId: offer!.id, branch: media.branch, kind: media.kind, mime: media.mime,
          fileName: media.fileName, bytes: media.bytes, size: media.bytes.byteLength,
        })
        keys.add(key)
        mediaAdded++
      }
      setAudit(c, { action: 'spy.flow.import', targetType: 'spy_offer', targetId: offer!.id, detail: { mediaAdded, conversations: imported.conversations.length } })
      return c.json({ id: offer!.id, title: imported.title, mediaAdded, conversations: imported.conversations.length }, 201)
    })
    .get('/api/spy/flows/:id', validate('param', adParam), async (c) => {
      const flow = await buildSpyFlow(deps.db, c.req.valid('param').id)
      if (!flow) throw new ApiError('NOT_FOUND', 'Fluxo não encontrado')
      const conversations = [
        ...capturedConversationFiles(flow),
        ...(flow.importedConversations ?? []),
      ]
      return c.json({
        id: flow.offerId, phone: flow.phone, title: flow.title ?? flow.pageName ?? `Fluxo ${flow.phone}`,
        source: flow.source ?? 'captured', status: flow.status, script: renderFlowPlaybook(flow),
        summary: renderFlowSummary(flow), conversations, media: flow.media,
      })
    })
    .patch('/api/spy/flows/:id', validate('param', adParam), validate('json', editFlowSchema), async (c) => {
      const { title, script } = c.req.valid('json')
      const [row] = await deps.db.update(spyOffers).set({ flowTitle: title, flowScript: script, updatedAt: new Date() })
        .where(eq(spyOffers.id, c.req.valid('param').id)).returning()
      if (!row) throw new ApiError('NOT_FOUND', 'Fluxo não encontrado')
      setAudit(c, { action: 'spy.flow.edit', targetType: 'spy_offer', targetId: row.id })
      return c.json({ id: row.id, title: row.flowTitle, script: row.flowScript })
    })
    .get('/api/spy/auto-probe', async (c) => c.json(await loadSpyAutoProbeConfig(deps.redis)))
    .put('/api/spy/auto-probe', validate('json', autoProbeSchema), async (c) => {
      const config = await saveSpyAutoProbeConfig(deps.redis, c.req.valid('json'))
      setAudit(c, { action: 'spy.auto_probe.configure', targetType: 'spy', detail: { excludedSessionIds: config.excludedSessionIds } })
      return c.json(config)
    })
    .post('/api/spy/ads', validate('json', spyLinksSchema), async (c) => {
      const links = [...new Set(c.req.valid('json').links)]
      const result = await store.enqueue(links, c.get('actor'))
      setAudit(c, { action: 'spy.enqueue', targetType: 'spy_ad', detail: { created: result.created.length, skipped: result.skipped.length } })
      return c.json(result, 201)
    })
    .post('/api/spy/ads/:id/retry', validate('param', adParam), async (c) => {
      const row = await store.retry(c.req.valid('param').id)
      if (!row) throw new ApiError('NOT_FOUND', 'Anúncio não encontrado ou ainda em andamento')
      return c.json(row)
    })
    .put('/api/spy/ads/:id/phone', validate('param', adParam), validate('json', manualPhoneSchema), async (c) => {
      const phone = normalizePhone(c.req.valid('json').phone)
      if (!phone) throw new ApiError('VALIDATION_ERROR', 'Número inválido: use o DDI, ex.: 5584920022034')
      const row = await store.found(c.req.valid('param').id, { phone, foundVia: 'manual' })
      if (!row) throw new ApiError('NOT_FOUND', 'Anúncio não encontrado')
      setAudit(c, { action: 'spy.manual_phone', targetType: 'spy_ad', targetId: row.id })
      return c.json(row)
    })
    .delete('/api/spy/ads/:id', validate('param', adParam), async (c) => {
      const { id } = c.req.valid('param')
      if (!(await store.remove(id))) throw new ApiError('NOT_FOUND', 'Anúncio não encontrado')
      setAudit(c, { action: 'spy.delete', targetType: 'spy_ad', targetId: id })
      return c.body(null, 204)
    })
    // Sondas: o worker (SpyProbeRunner) pega a sonda criada aqui e conversa com a oferta.
    .get('/api/spy/probes', async (c) => c.json({ items: await probes.list() }))
    .get('/api/spy/probes/:id/messages', validate('param', adParam), async (c) => {
      const probe = await probes.get(c.req.valid('param').id)
      if (!probe) throw new ApiError('NOT_FOUND', 'Sonda não encontrada')
      return c.json({ items: (await probes.history(probe)).map((t) => ({ de: t.de, texto: t.texto, at: t.at.toISOString() })) })
    })
    // Pacote (ZIP) do fluxo de uma oferta: resumo, roteiro, a conversa de cada ramificação e as imagens/PDFs.
    .get('/api/spy/offers/:id/flow.zip', validate('param', adParam), async (c) => {
      const flow = await buildSpyFlow(deps.db, c.req.valid('param').id)
      if (!flow) throw new ApiError('NOT_FOUND', 'Oferta não encontrada')
      const zip = new JSZip()
      zip.file('resumo.md', renderFlowSummary(flow))
      zip.file('roteiro.txt', renderFlowPlaybook(flow))
      for (const conversation of capturedConversationFiles(flow)) zip.file(conversation.fileName, conversation.content)
      for (const imported of flow.importedConversations ?? []) if (!zip.file(imported.fileName)) zip.file(imported.fileName, imported.content)
      const files = await deps.db.select().from(spyMedia).where(eq(spyMedia.offerId, flow.offerId)).orderBy(asc(spyMedia.createdAt))
      files.forEach((m, i) => zip.file(mediaZipPath({ id: m.id, probeId: m.probeId, branch: m.branch, kind: m.kind, mime: m.mime, fileName: m.fileName, size: m.size }, i + 1), m.bytes))
      const buf = await zip.generateAsync({ type: 'nodebuffer' })
      const slug = (flow.title ?? flow.pageName ?? flow.phone).replace(/[^\w.-]+/g, '-').slice(0, 60) || flow.phone
      c.header('Content-Type', 'application/zip')
      c.header('Content-Disposition', `attachment; filename="funil-${slug}.zip"`)
      return c.body(new Uint8Array(buf))
    })
    // Importa roteiro e mídias como um fluxo editável no CRM pela integração interna.
    .post('/api/spy/offers/:id/copy-to-crm', validate('param', adParam), async (c) => {
      const flow = await buildSpyFlow(deps.db, c.req.valid('param').id)
      if (!flow) throw new ApiError('NOT_FOUND', 'Oferta não encontrada')
      const files = await deps.db.select().from(spyMedia).where(eq(spyMedia.offerId, flow.offerId)).orderBy(asc(spyMedia.createdAt))
      const latest = [...flow.branches].reverse().find((b) => b.summary?.etapa)
      const token = process.env.INTERNAL_TOKEN?.trim()
      if (!token) throw new ApiError('INTERNAL_ERROR', 'INTERNAL_TOKEN nao configurado')
      const response = await fetch(`${process.env.CRM_INTERNAL_URL ?? 'http://crm-api:3000'}/internal/spy-flow-import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          title: flow.title ?? flow.pageName ?? `Oferta ${flow.phone}`,
          phone: flow.phone,
          stage: latest?.summary?.etapa ?? (flow.status === 'completa' ? 'Concluida' : 'Em andamento'),
          script: renderFlowPlaybook(flow),
          branches: flow.branches.map((b) => ({ branch: b.branch, turns: b.turns.map((t) => ({ de: t.de, texto: t.texto })) })),
          media: files.map((m) => ({ mime: m.mime, fileName: m.fileName, bytes: Buffer.from(m.bytes).toString('base64') })),
        }),
      })
      const result = await response.json().catch(() => ({})) as { flowId?: string; editUrl?: string; mediaCount?: number; error?: { message?: string } }
      if (!response.ok || !result.flowId || !result.editUrl) throw new ApiError('INTERNAL_ERROR', result.error?.message ?? `CRM recusou a importacao (${response.status})`)
      setAudit(c, { action: 'spy.copy_to_crm', targetType: 'spy_offer', targetId: flow.offerId, detail: { flowId: result.flowId, mediaCount: result.mediaCount ?? 0 } })
      return c.json({ ok: true, flowId: result.flowId, editUrl: result.editUrl, mediaCount: result.mediaCount ?? 0 })
    })
    .post('/api/spy/offers/:id/probes', validate('param', adParam), validate('json', startProbeSchema), async (c) => {
      try {
        const { sessionId, branch, startInMinutes } = c.req.valid('json')
        const probe = await probes.create({ offerId: c.req.valid('param').id, sessionId, branch, startInMs: startInMinutes * 60_000, createdBy: c.get('actor') })
        setAudit(c, { action: 'spy.probe.start', targetType: 'spy_probe', targetId: probe.id })
        return c.json(probe, 201)
      } catch (err) {
        if (err instanceof SpyProbeError) throw new ApiError(PROBE_ERRORS[err.code], err.message)
        throw err
      }
    })
    .post('/api/spy/probes/:id/stop', validate('param', adParam), async (c) => {
      const { id } = c.req.valid('param')
      const row = await probes.end(id, 'parada', `parada por ${c.get('actor')}`, { listen: false })
      if (!row) throw new ApiError('NOT_FOUND', 'Sonda não encontrada ou já parada')
      setAudit(c, { action: 'spy.probe.stop', targetType: 'spy_probe', targetId: id })
      return c.json(row)
    })
}

function captureError(err: unknown) {
  if (!(err instanceof SpyCaptureError)) return err
  return new ApiError(err.code === 'INVALID_URL' ? 'VALIDATION_ERROR' : err.code === 'LEGACY_CAPTURE' ? 'INVALID_TRANSITION' : 'NOT_FOUND', err.message)
}

const startProbeSchema = z.object({
  sessionId: z.uuid(),
  branch: z.enum(SPY_BRANCHES).default('principal'),
  /** Atraso da abertura (várias sondas na mesma oferta em horários diferentes). */
  startInMinutes: z.number().int().min(0).max(180).default(0),
}).strict()

/** Mantém todas as tentativas: principal.md, principal-2.md etc., sem sobrescrever conversa anterior. */
function capturedConversationFiles(flow: SpyFlow): Array<{ fileName: string; content: string }> {
  const seen = new Map<string, number>()
  return flow.branches.map((branch) => {
    const n = (seen.get(branch.branch) ?? 0) + 1
    seen.set(branch.branch, n)
    return {
      fileName: `conversa-${branch.branch}${n > 1 ? `-${n}` : ''}.md`,
      content: renderBranchConversation(flow, branch),
    }
  })
}

const PROBE_ERRORS: Record<SpyProbeError['code'], ErrorCode> = {
  OFFER_NOT_FOUND: 'NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_NOT_READY: 'SESSION_NOT_CONNECTED',
  PROBE_ACTIVE: 'INVALID_TRANSITION',
  DAILY_LIMIT: 'RATE_LIMIT',
  OPT_OUT: 'CONTACT_NOT_ALLOWED',
  OWN_NUMBER: 'VALIDATION_ERROR',
}
