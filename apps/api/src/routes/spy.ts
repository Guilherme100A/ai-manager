// Espião de funil: links de anúncios entram na fila; o SpyRunner (server.ts) acha o WhatsApp de cada oferta.
import { Hono } from 'hono'
import { z } from 'zod'
import JSZip from 'jszip'
import { asc, eq } from 'drizzle-orm'
import { AiSettingsService, buildSpyFlow, mediaZipPath, renderBranchConversation, renderFlowPlaybook, renderFlowSummary, SpyProbeError, SpyProbeStore, SpyStore, normalizePhone } from '@wsm/core'
import { spyMedia, SPY_BRANCHES } from '@wsm/db'
import { ApiError, type ErrorCode } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

export const spyLinksSchema = z.object({
  links: z.array(z.string().trim().min(1).max(2048)).min(1).max(50),
}).strict()

const adParam = z.object({ id: z.uuid() })
const manualPhoneSchema = z.object({ phone: z.string().trim().min(8).max(40) }).strict()

export function spyRoutes(deps: Pick<AppDeps, 'db'>) {
  const store = new SpyStore(deps.db)
  const probes = new SpyProbeStore(deps.db)
  return new Hono<AppEnv>()
    .get('/api/spy/ads', async (c) => c.json({ items: await store.listAds() }))
    .get('/api/spy/offers', async (c) => c.json({ items: await store.listOffers() }))
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
      for (const b of flow.branches) zip.file(`conversa-${b.branch}.md`, renderBranchConversation(flow, b))
      const files = await deps.db.select().from(spyMedia).where(eq(spyMedia.offerId, flow.offerId)).orderBy(asc(spyMedia.createdAt))
      files.forEach((m, i) => zip.file(mediaZipPath({ id: m.id, probeId: m.probeId, branch: m.branch, kind: m.kind, mime: m.mime, fileName: m.fileName, size: m.size }, i + 1), m.bytes))
      const buf = await zip.generateAsync({ type: 'nodebuffer' })
      const slug = (flow.pageName ?? flow.phone).replace(/[^\w.-]+/g, '-').slice(0, 60) || flow.phone
      c.header('Content-Type', 'application/zip')
      c.header('Content-Disposition', `attachment; filename="funil-${slug}.zip"`)
      return c.body(new Uint8Array(buf))
    })
    // Copia o fluxo pra IA do CRM: salva o roteiro como contexto do negócio; as sugestões passam a seguir o funil.
    .post('/api/spy/offers/:id/copy-to-crm', validate('param', adParam), async (c) => {
      const flow = await buildSpyFlow(deps.db, c.req.valid('param').id)
      if (!flow) throw new ApiError('NOT_FOUND', 'Oferta não encontrada')
      const { chars } = await new AiSettingsService({ db: deps.db }).setBusinessContext(renderFlowPlaybook(flow))
      setAudit(c, { action: 'spy.copy_to_crm', targetType: 'spy_offer', targetId: flow.offerId, detail: { chars } })
      return c.json({ ok: true, chars })
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

const startProbeSchema = z.object({
  sessionId: z.uuid(),
  branch: z.enum(SPY_BRANCHES).default('principal'),
  /** Atraso da abertura (várias sondas na mesma oferta em horários diferentes). */
  startInMinutes: z.number().int().min(0).max(180).default(0),
}).strict()

const PROBE_ERRORS: Record<SpyProbeError['code'], ErrorCode> = {
  OFFER_NOT_FOUND: 'NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_NOT_READY: 'SESSION_NOT_CONNECTED',
  PROBE_ACTIVE: 'INVALID_TRANSITION',
  DAILY_LIMIT: 'RATE_LIMIT',
  OPT_OUT: 'CONTACT_NOT_ALLOWED',
  OWN_NUMBER: 'VALIDATION_ERROR',
}
