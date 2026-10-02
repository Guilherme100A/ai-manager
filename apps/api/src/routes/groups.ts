// /api/sessions/:id/groups (T14): leitura dos grupos via transport.fetchGroups() e releitura manual auditada.
// Entrada por convite disponível somente na ação autenticada entre duas sessões.
// T20: POST /api/sessions/:id/groups/:groupId/participants adiciona UM número (outra sessão do sistema) a um grupo
// em que a sessão é admin. Só pela rota autenticada, um alvo por requisição, no máximo 1 tentativa por minuto.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  GROUP_ADD_AUDIT_ACTION,
  GroupInviteError,
  SendRejectedError,
  type GroupAutomationConfig,
  type GroupInviteInput,
  type GroupInviteOutcome,
  GroupAddError,
  GroupParticipantService,
  listSessionGroups,
  SessionError,
  SessionNotConnectedError,
  SessionStore,
  type GroupAddOutcome,
  type WaTransport,
} from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit, writeAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

declare module './sessions' {
  interface SessionsControl {
    getGroupAutomation?(id: string): Promise<unknown>
    configureGroupAutomation?(id: string, config: GroupAutomationConfig): Promise<unknown>
    tickGroupAutomation?(id: string): Promise<unknown>
    runGroupInvite?(input: GroupInviteInput): Promise<GroupInviteOutcome>
    /** Transporte vivo da sessão (SessionManager.getTransport). */
    getTransport?(sessionId: string): WaTransport | undefined
    /** T20 — adiciona UM número a um grupo; o worker (ponte) executa as checagens e o freio. */
    addGroupParticipant?(adminSessionId: string, groupId: string, targetSessionId: string): Promise<GroupAddOutcome>
  }
}

declare module '../types' {
  interface AppDeps {
    /** T20 — relógio (ms) do freio de adições quando o serviço roda na própria API (testes). */
    groupAddNow?: () => number
  }
}

/** Um único alvo por requisição (array ou campo extra → 400). */
export const addParticipantSchema = z.object({ targetSessionId: z.uuid() }).strict()

export const inviteFlowSchema = z.object({
  targetSessionId: z.uuid(),
  groupIds: z.array(z.string().regex(/^[^\s@]+@g\.us$/).max(200)).min(1).max(100),
}).strict()

export const groupAutomationSchema = z.object({
  enabled: z.boolean(), query: z.string().trim().min(1).max(300),
  maxEntriesPerDay: z.number().int().min(1).max(20), targetSessionId: z.uuid().nullable(),
}).strict()

const uuid = z.uuid()

function sessionId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? ''
  if (!uuid.safeParse(id).success) throw new ApiError('SESSION_NOT_FOUND', `session ${id} not found`)
  return id
}

function toApiError(err: unknown): unknown {
  if (err instanceof SessionNotConnectedError) return new ApiError('SESSION_NOT_CONNECTED', err.message)
  if (err instanceof SessionError && err.code === 'SESSION_NOT_FOUND') return new ApiError('SESSION_NOT_FOUND', err.message)
  return err
}

export function groupsRoutes(deps: Pick<AppDeps, 'db' | 'sessions' | 'groupAddNow'>) {
  const store = new SessionStore(deps.db)
  const getTransport = (id: string) => deps.sessions?.getTransport?.(id)
  // Sem ponte (API e worker no mesmo processo): o serviço roda aqui, com o transporte do SessionManager.
  const localGroups = new GroupParticipantService({ db: deps.db, getTransport, ...(deps.groupAddNow ? { now: deps.groupAddNow } : {}) })
  const addParticipant = (adminSessionId: string, groupId: string, targetSessionId: string) =>
    deps.sessions?.addGroupParticipant
      ? deps.sessions.addGroupParticipant(adminSessionId, groupId, targetSessionId)
      : localGroups.add({ adminSessionId, groupId, targetSessionId })

  const list = async (id: string) => {
    try {
      return await listSessionGroups({ store, sessionId: id, getTransport })
    } catch (err) {
      throw toApiError(err)
    }
  }

  return new Hono<AppEnv>()
    .get('/api/sessions/:id/groups/automation', async (c) => {
      if (!deps.sessions?.getGroupAutomation) throw new ApiError('INTERNAL_ERROR', 'Automação indisponível no worker.')
      try { return c.json(await deps.sessions.getGroupAutomation(sessionId(c)) as object) } catch (err) { throw toApiError(err) }
    })
    .put('/api/sessions/:id/groups/automation', validate('json', groupAutomationSchema), async (c) => {
      const id = sessionId(c)
      const config = c.req.valid('json')
      if (config.targetSessionId === id) throw new ApiError('VALIDATION_ERROR', 'Escolha outra sessão como destinatária.')
      if (!deps.sessions?.configureGroupAutomation) throw new ApiError('INTERNAL_ERROR', 'Automação indisponível no worker.')
      try {
        const result = await deps.sessions.configureGroupAutomation(id, config)
        setAudit(c, { action: 'group.automation.configure', targetType: 'session', targetId: id, detail: { ...config } })
        return c.json(result as object)
      } catch (err) { throw toApiError(err) }
    })
    .post('/api/sessions/:id/groups/automation/run', async (c) => {
      if (!deps.sessions?.tickGroupAutomation) throw new ApiError('INTERNAL_ERROR', 'Automação indisponível no worker.')
      try { return c.json(await deps.sessions.tickGroupAutomation(sessionId(c)) as object, 202) } catch (err) { throw toApiError(err) }
    })
    .post('/api/sessions/:id/groups/invite-flow', validate('json', inviteFlowSchema), async (c) => {
      const sourceSessionId = sessionId(c)
      const body = c.req.valid('json')
      if (!deps.sessions?.runGroupInvite) throw new ApiError('INTERNAL_ERROR', 'Fluxo de convites indisponível no worker.')
      try {
        const out = await deps.sessions.runGroupInvite({ ...body, sourceSessionId, actor: c.get('actor') ?? '' })
        setAudit(c, { action: 'group.invite.request', targetType: 'session', targetId: sourceSessionId, detail: { ...out } })
        return c.json(out)
      } catch (err) {
        if (err instanceof GroupInviteError || err instanceof SendRejectedError) throw new ApiError(err.code, err.message)
        throw toApiError(err)
      }
    })
    .get('/api/sessions/:id/groups', async (c) => c.json({ items: await list(sessionId(c)) }))
    .post('/api/sessions/:id/groups/refresh', async (c) => {
      const id = sessionId(c)
      const items = await list(id)
      setAudit(c, { action: 'group.refresh', targetType: 'session', targetId: id, detail: { count: items.length } })
      return c.json({ items })
    })
    .post('/api/sessions/:id/groups/:groupId/participants', validate('json', addParticipantSchema), async (c) => {
      const adminSessionId = c.req.param('id') ?? ''
      const groupId = c.req.param('groupId') ?? ''
      const { targetSessionId } = c.req.valid('json')
      try {
        const out = await addParticipant(adminSessionId, groupId, targetSessionId)
        setAudit(c, {
          action: GROUP_ADD_AUDIT_ACTION,
          targetType: 'session',
          targetId: adminSessionId,
          detail: {
            groupId,
            targetSessionId,
            jid: out.jid,
            result: out.result,
            attempted: true,
            // attemptId libera a reserva do freio; clockAt é o relógio do serviço (janela de 1 minuto).
            attemptId: out.attemptId,
            clockAt: out.clockAt,
            ...(out.code !== undefined ? { code: out.code } : {}),
          },
        })
        const body: Record<string, unknown> = { result: out.result, groupId, targetSessionId, jid: out.jid }
        if (out.code !== undefined) body.code = out.code
        return c.json(body)
      } catch (err) {
        if (!(err instanceof GroupAddError)) throw err
        // Falhas também são auditadas (o middleware só audita respostas 2xx).
        await writeAudit(deps.db, {
          actor: c.get('actor') ?? 'anonymous',
          action: GROUP_ADD_AUDIT_ACTION,
          targetType: 'session',
          targetId: adminSessionId,
          detail: {
            request_id: c.get('requestId'),
            status: err.status,
            groupId,
            targetSessionId,
            jid: err.details.jid,
            result: err.details.result,
            attempted: err.details.attempted,
            errorCode: err.code,
            ...(err.details.attemptId ? { attemptId: err.details.attemptId, clockAt: err.details.clockAt } : {}),
          },
        }).catch((e: unknown) => c.get('logger')?.error({ err: e }, 'failed to write audit log'))
        const { attemptId: _attemptId, clockAt: _clockAt, ...details } = err.details
        return c.json({ error: { code: err.code, message: err.message, details } }, err.status as 400 | 403 | 404 | 409 | 429)
      }
    })
}
