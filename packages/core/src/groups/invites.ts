import { randomInt } from 'node:crypto'
import type { SessionStore } from '../session/store'
import { SENDABLE_STATES } from '../session/states'
import type { SendPipeline } from '../send/pipeline'
import { normalizeJid } from '../transport/baileys'
import type { IncomingMessage, WaTransport } from '../transport'
import { phoneToUserJid } from './participants'

export interface GroupInviteInput {
  sourceSessionId: string
  targetSessionId: string
  groupIds: string[]
  actor: string
}

export interface GroupInviteOutcome {
  groupId: string
  targetSessionId: string
  messageId: string
  result: 'joined' | 'awaiting_confirmation'
}

export class GroupInviteError extends Error {
  constructor(readonly code: 'VALIDATION_ERROR' | 'SESSION_NOT_CONNECTED' | 'RATE_LIMIT' | 'GROUP_INVITE_FAILED', message: string) {
    super(message)
    this.name = 'GroupInviteError'
  }
}

export interface GroupInviteServiceOptions {
  sessions: Pick<SessionStore, 'get'>
  getTransport: (id: string) => WaTransport | undefined
  pipeline: Pick<SendPipeline, 'send'>
  cancelMessage: (id: string) => Promise<unknown>
  audit: (input: GroupInviteInput, detail: Record<string, unknown>) => Promise<void>
  receiptTimeoutMs?: number
}

/** Uma ação do painel: sorteia um grupo autorizado, envia pela fila e espera B receber o link antes de aceitar. */
export class GroupInviteService {
  private readonly reserved = new Map<string, number>()
  constructor(private readonly opts: GroupInviteServiceOptions) {}

  async run(input: GroupInviteInput): Promise<GroupInviteOutcome> {
    const { sourceSessionId, targetSessionId, actor } = input
    if (!actor?.trim() || sourceSessionId === targetSessionId || !input.groupIds.length) {
      throw new GroupInviteError('VALIDATION_ERROR', 'Escolha duas sessões diferentes e pelo menos um grupo.')
    }
    const ids = [sourceSessionId, targetSessionId]
    if (ids.some((id) => (this.reserved.get(id) ?? 0) > Date.now())) {
      throw new GroupInviteError('RATE_LIMIT', 'Aguarde: já existe uma tentativa recente para uma dessas sessões.')
    }
    // Reserva antes de qualquer await para impedir dois fluxos concorrentes usando a mesma sessão.
    for (const id of ids) this.reserved.set(id, Infinity)
    let attempted = false
    let groupId: string | undefined
    let messageId: string | undefined
    let outcome = 'failed'
    let listener: ((message: IncomingMessage) => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let target: WaTransport | undefined
    try {
      const [sourceSession, targetSession] = await Promise.all(ids.map((id) => this.opts.sessions.get(id)))
      const source = this.opts.getTransport(sourceSessionId)
      target = this.opts.getTransport(targetSessionId)
      if (!source || !target || !sourceSession || !targetSession ||
          !SENDABLE_STATES.includes(sourceSession.status) || !SENDABLE_STATES.includes(targetSession.status)) {
        throw new GroupInviteError('SESSION_NOT_CONNECTED', 'As duas sessões precisam estar conectadas e ativas.')
      }
      if (!sourceSession.phone || !targetSession.phone || sourceSession.phone === targetSession.phone) {
        throw new GroupInviteError('VALIDATION_ERROR', 'As sessões precisam ter números diferentes e válidos.')
      }
      if (!source.groupInviteCode || !target.groupAcceptInvite || !target.off) {
        throw new GroupInviteError('GROUP_INVITE_FAILED', 'O transporte não suporta convites entre sessões.')
      }
      const [sourceGroups, targetGroups] = await Promise.all([source.fetchGroups(), target.fetchGroups()])
      const pool = new Set(input.groupIds)
      const existing = new Set(targetGroups.map((g) => g.id))
      const candidates = sourceGroups.filter((g) => pool.has(g.id) && g.isAdmin === true &&
        g.id.endsWith('@g.us') && !existing.has(g.id))
      if (!candidates.length) {
        throw new GroupInviteError('VALIDATION_ERROR', 'Nenhum grupo elegível: A precisa ser admin e B ainda não pode ser membro.')
      }
      groupId = candidates[randomInt(candidates.length)]!.id
      const code = await source.groupInviteCode(groupId)
      const link = `https://chat.whatsapp.com/${code}`
      const expectedSender = phoneToUserJid(sourceSession.phone)
      const receipt = new Promise<boolean>((resolve) => {
        listener = (message) => {
          if (message.fromMe || message.text !== link || message.from.endsWith('@g.us')) return
          if (![message.from, message.fromAlt].some((jid) => jid && normalizeJid(jid) === expectedSender)) return
          resolve(true)
        }
        target!.on('message', listener)
        timer = setTimeout(() => resolve(false), this.opts.receiptTimeoutMs ?? 30_000)
      })
      // Registra a tentativa antes do efeito externo; não grava o código de convite na auditoria.
      await this.opts.audit(input, { groupId, result: 'started' })
      attempted = true
      const message = await this.opts.pipeline.send({
        sessionId: sourceSessionId, phone: targetSession.phone, content: { text: link }, actor,
      })
      messageId = message.id
      if (!(await receipt)) {
        await this.opts.cancelMessage(message.id).catch(() => undefined)
        throw new GroupInviteError('GROUP_INVITE_FAILED', 'B não recebeu o convite dentro de 30 segundos. Confira a fila de mensagens.')
      }
      if (this.opts.getTransport(sourceSessionId) !== source || this.opts.getTransport(targetSessionId) !== target) {
        throw new GroupInviteError('SESSION_NOT_CONNECTED', 'Uma sessão reconectou durante o fluxo. Tente novamente.')
      }
      const currentSessions = await Promise.all(ids.map((id) => this.opts.sessions.get(id)))
      if (currentSessions.some((session) => !SENDABLE_STATES.includes(session.status))) {
        throw new GroupInviteError('SESSION_NOT_CONNECTED', 'Uma sessão foi pausada durante o fluxo. Tente novamente.')
      }
      const acceptedGroup = await target.groupAcceptInvite(code)
      if (acceptedGroup && acceptedGroup !== groupId) {
        throw new GroupInviteError('GROUP_INVITE_FAILED', 'O WhatsApp retornou um grupo diferente do selecionado.')
      }
      const groups = await target.fetchGroups()
      const result = groups.some((g) => g.id === groupId) ? 'joined' : 'awaiting_confirmation'
      outcome = result
      return { groupId, targetSessionId, messageId: message.id, result }
    } finally {
      if (timer) clearTimeout(timer)
      if (listener) target?.off?.('message', listener)
      for (const id of ids) {
        if (attempted) this.reserved.set(id, Date.now() + 60_000)
        else this.reserved.delete(id)
      }
      if (attempted) await this.opts.audit(input, { groupId, messageId, result: outcome })
    }
  }
}
