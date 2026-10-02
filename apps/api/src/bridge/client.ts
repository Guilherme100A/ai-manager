// Ponte API → worker (T16): a API roda num container e o SessionManager/MessageQueue/HealthMonitor no worker.
// Os clientes abaixo implementam as MESMAS interfaces que as rotas já usam (SessionsControl, MessagesControl +
// enqueue, HealthControl), falando com POST /internal/rpc do worker (Bearer INTERNAL_TOKEN). Os erros de
// domínio são recriados com as classes originais para que o mapeamento HTTP das rotas não mude.
import {
  GroupAddError,
  GroupInviteError,
  SendRejectedError,
  InvalidTransitionError,
  MessageNotFoundError,
  MessageTransitionError,
  ProxyError,
  SessionError,
  SessionNotConnectedError,
  TransportNotConnectedError,
  type EnqueueMessageInput,
  type GroupAddOutcome,
  type GroupAutomationConfig,
  type GroupInviteInput,
  type GroupInviteOutcome,
  type GroupSummary,
  type MessagesControl,
  type MessageView,
  type SendQueue,
  type SessionHealth,
  type WaTransport,
} from '@wsm/core'
import type { HealthControl } from '../routes/health-session'
import type { SessionsControl } from '../routes/sessions'

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number
  json(): Promise<unknown>
}>

export interface WorkerBridgeOptions {
  /** Ex.: http://worker:9465 */
  url: string
  token: string
  fetch?: FetchLike
  /** Timeout de cada chamada (default 60 s: o pairing code espera o evento do transporte). */
  timeoutMs?: number
}

export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerUnavailableError'
  }
}

export interface RemoteErrorPayload {
  name?: string
  message?: string
  code?: string
  from?: string
  to?: string
  messageId?: string
  sessionId?: string
  proxyId?: string
  [k: string]: unknown
}

/** Recria o erro de domínio a partir do payload serializado pelo worker. */
export function reviveError(e: RemoteErrorPayload): Error {
  const msg = e.message ?? 'worker error'
  switch (e.name) {
    case 'InvalidTransitionError':
      return new InvalidTransitionError(e.from as never, e.to ?? '', msg)
    case 'SessionError':
      return new SessionError(e.code as never, msg)
    case 'ProxyError':
    case 'ProxyUnavailableError':
      return new ProxyError(e.code as never, msg)
    case 'MessageNotFoundError':
      return new MessageNotFoundError(e.messageId ?? '')
    case 'MessageTransitionError':
      return new MessageTransitionError(e.from as never, e.to as never, msg)
    case 'SessionNotConnectedError':
      return new SessionNotConnectedError(e.sessionId ?? '', msg)
    case 'TransportNotConnectedError':
      return new TransportNotConnectedError(msg)
    case 'GroupInviteError':
      return new GroupInviteError(e.code as never, msg)
    case 'SendRejectedError':
      return new SendRejectedError(e.code as never, msg, e.details as never)
    case 'GroupAddError':
      return new GroupAddError(e.code as never, msg, (e.details ?? { result: 'failed', attempted: false, jid: null }) as never)
    default: {
      const err = new Error(msg)
      err.name = e.name ?? 'Error'
      if (e.code) Object.assign(err, { code: e.code })
      return err
    }
  }
}

export interface WorkerBridge {
  call<T>(target: string, method: string, ...args: unknown[]): Promise<T>
  sessions: SessionsControl & {
    getTransport(sessionId: string): WaTransport
    getGroupAutomation(id: string): Promise<unknown>
    configureGroupAutomation(id: string, config: GroupAutomationConfig): Promise<unknown>
    tickGroupAutomation(id: string): Promise<unknown>
    runGroupInvite(input: GroupInviteInput): Promise<GroupInviteOutcome>
    addGroupParticipant(adminSessionId: string, groupId: string, targetSessionId: string): Promise<GroupAddOutcome>
  }
  messages: MessagesControl & SendQueue
  health: HealthControl
}

export function createWorkerBridge(opts: WorkerBridgeOptions): WorkerBridge {
  const base = opts.url.replace(/\/+$/, '')
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  const timeoutMs = opts.timeoutMs ?? 60_000

  async function call<T>(target: string, method: string, ...args: unknown[]): Promise<T> {
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await doFetch(`${base}/internal/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ target, method, args }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw new WorkerUnavailableError(`worker unreachable: ${err instanceof Error ? err.message : String(err)}`)
    }
    let payload: { result?: unknown; error?: RemoteErrorPayload }
    try {
      payload = (await res.json()) as typeof payload
    } catch {
      throw new WorkerUnavailableError(`invalid worker response (HTTP ${res.status})`)
    }
    if (payload.error) {
      if (res.status === 401) throw new WorkerUnavailableError('worker rejected the internal token')
      throw reviveError(payload.error)
    }
    if (res.status >= 400) throw new WorkerUnavailableError(`worker HTTP ${res.status}`)
    return payload.result as T
  }

  /** Transporte remoto: só leitura de grupos (T14). Envio nunca passa por aqui (SPEC 1.4 #2). */
  const remoteTransport = (sessionId: string): WaTransport => {
    const unsupported = async (): Promise<never> => {
      throw new Error('operation not available through the worker bridge')
    }
    return {
      connect: unsupported,
      on: () => undefined,
      sendMessage: unsupported,
      fetchGroups: () => call<GroupSummary[]>('sessions', 'fetchGroups', sessionId),
      // T20: a adição a grupo passa por sessions.addGroupParticipant (checagens e freio no worker), nunca por aqui.
      addGroupParticipant: unsupported,
      logout: unsupported,
      close: unsupported,
    } as WaTransport
  }

  const sessions: WorkerBridge['sessions'] = {
    getGroupAutomation: (id) => call('sessions', 'getGroupAutomation', id),
    configureGroupAutomation: (id, input) => call('sessions', 'configureGroupAutomation', id, input),
    tickGroupAutomation: (id) => call('sessions', 'tickGroupAutomation', id),
    runGroupInvite: (input) => call('sessions', 'runGroupInvite', input),
    create: (input) => call('sessions', 'create', input),
    list: () => call('sessions', 'list'),
    get: (id) => call('sessions', 'get', id),
    startQr: (id) => call('sessions', 'startQr', id),
    getQr: (id) => call('sessions', 'getQr', id),
    requestPairingCode: (id, phone) => call('sessions', 'requestPairingCode', id, phone ?? null),
    pause: (id) => call('sessions', 'pause', id),
    resume: (id) => call('sessions', 'resume', id),
    restart: (id) => call('sessions', 'restart', id),
    logout: (id) => call('sessions', 'logout', id),
    getTransport: remoteTransport,
    addGroupParticipant: (adminSessionId, groupId, targetSessionId) => call<GroupAddOutcome>('sessions', 'addGroupParticipant', adminSessionId, groupId, targetSessionId),
  }

  const messages: WorkerBridge['messages'] = {
    get: (id) => call<MessageView>('messages', 'get', id),
    list: (filter) => call<MessageView[]>('messages', 'list', filter ?? {}),
    events: (id) => call('messages', 'events', id),
    cancel: (id) => call<MessageView>('messages', 'cancel', id),
    enqueue: (input: EnqueueMessageInput) => call<MessageView>('messages', 'enqueue', input),
  }

  const health: HealthControl = { getHealth: (id) => call<SessionHealth>('health', 'getHealth', id) }

  return { call, sessions, messages, health }
}
