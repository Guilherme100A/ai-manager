import { Hono } from 'hono'
import { z } from 'zod'
import { conversationConfigSchema, SessionError, type ConversationConfig } from '@wsm/core'
import { ApiError } from '../errors'
import { setAudit } from '../middleware/audit'
import type { AppDeps, AppEnv } from '../types'
import { validate } from '../validate'

declare module './sessions' {
  interface SessionsControl {
    getConversation?(id: string): Promise<unknown>
    configureConversation?(id: string, config: ConversationConfig): Promise<unknown>
    tickConversation?(id: string): Promise<unknown>
  }
}
export function conversationRoutes(deps: Pick<AppDeps, 'sessions'>) {
  const call = async (fn: () => Promise<unknown>) => {
    try { return await fn() as object } catch (error) {
      if (error instanceof SessionError && (error.code === 'SESSION_NOT_FOUND' || error.code === 'VALIDATION_ERROR')) throw new ApiError(error.code, error.message)
      throw error
    }
  }
  return new Hono<AppEnv>()
    .get('/api/sessions/:id/conversation', async (c) => {
      const id = c.req.param('id')
      if (!z.uuid().safeParse(id).success) throw new ApiError('SESSION_NOT_FOUND', 'Sessão inválida.')
      if (!deps.sessions?.getConversation) throw new ApiError('INTERNAL_ERROR', 'Conversas indisponíveis no worker.')
      return c.json(await call(() => deps.sessions!.getConversation!(id)))
    })
    .put('/api/sessions/:id/conversation', validate('json', conversationConfigSchema), async (c) => {
      const id = c.req.param('id')
      if (!z.uuid().safeParse(id).success) throw new ApiError('SESSION_NOT_FOUND', 'Sessão inválida.')
      const config = c.req.valid('json')
      if (config.targetSessionId === id) throw new ApiError('VALIDATION_ERROR', 'Escolha outra conta.')
      if (!deps.sessions?.configureConversation) throw new ApiError('INTERNAL_ERROR', 'Conversas indisponíveis no worker.')
      try {
        const result = await deps.sessions.configureConversation(id, config)
        setAudit(c, { action: 'conversation.configure', targetType: 'session', targetId: id, detail: config })
        return c.json(result as object)
      } catch (error) {
        if (error instanceof SessionError && error.code === 'VALIDATION_ERROR') throw new ApiError('VALIDATION_ERROR', error.message)
        throw error
      }
    })
    .post('/api/sessions/:id/conversation/run', async (c) => {
      const id = c.req.param('id')
      if (!z.uuid().safeParse(id).success) throw new ApiError('SESSION_NOT_FOUND', 'Sessão inválida.')
      if (!deps.sessions?.tickConversation) throw new ApiError('INTERNAL_ERROR', 'Conversas indisponíveis no worker.')
      return c.json(await call(() => deps.sessions!.tickConversation!(id)), 202)
    })
}
