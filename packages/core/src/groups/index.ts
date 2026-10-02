// T14 — grupos: somente leitura (transport.fetchGroups) e ações manuais disparadas pela API.
// Convites entre sessões são executados somente pela ação explícita no painel.
import { SENDABLE_STATES } from '../session/states'
import type { SessionRow } from '../session/store'
import { TransportNotConnectedError, type GroupSummary, type WaTransport } from '../transport'

/** `announce`: só admins enviam mensagens; `open`: todos os participantes enviam. */
export const GROUP_STATUSES = ['open', 'announce'] as const
export type GroupStatus = (typeof GROUP_STATUSES)[number]

export interface GroupView {
  id: string
  name: string
  /** Quantidade de participantes. */
  participants: number
  status: GroupStatus
  announce: boolean
  communityId: string | null
  /** T20 — a sessão é admin do grupo (pode adicionar números manualmente). */
  isAdmin: boolean
}

export function toGroupView(g: GroupSummary): GroupView {
  return {
    id: g.id,
    name: g.name,
    participants: g.participants,
    status: g.announce ? 'announce' : 'open',
    announce: g.announce,
    communityId: g.communityId ?? null,
    isAdmin: g.isAdmin === true,
  }
}

export class SessionNotConnectedError extends Error {
  readonly code = 'SESSION_NOT_CONNECTED'
  constructor(
    readonly sessionId: string,
    message = `session ${sessionId} is not connected`,
  ) {
    super(message)
    this.name = 'SessionNotConnectedError'
  }
}

/** Lista os grupos do transporte, ordenados por nome. Transporte desconectado → SessionNotConnectedError. */
export async function listGroups(transport: WaTransport, sessionId = ''): Promise<GroupView[]> {
  let groups: GroupSummary[]
  try {
    groups = await transport.fetchGroups()
  } catch (err) {
    if (err instanceof TransportNotConnectedError) throw new SessionNotConnectedError(sessionId)
    throw err
  }
  return groups.map(toGroupView).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export interface ListSessionGroupsOptions {
  /** Leitura da sessão (ex.: SessionStore); lança SESSION_NOT_FOUND se não existir. */
  store: { get(id: string): Promise<Pick<SessionRow, 'id' | 'status'>> }
  sessionId: string
  /** Transporte vivo da sessão (ex.: SessionManager.getTransport). */
  getTransport?: (sessionId: string) => WaTransport | undefined
}

/**
 * Grupos de uma sessão. Exige sessão em WARMING/STABLE (SPEC 3.4) com transporte vivo;
 * caso contrário lança SessionNotConnectedError.
 */
export async function listSessionGroups(opts: ListSessionGroupsOptions): Promise<GroupView[]> {
  const session = await opts.store.get(opts.sessionId)
  if (!SENDABLE_STATES.includes(session.status)) {
    throw new SessionNotConnectedError(opts.sessionId, `session ${opts.sessionId} is ${session.status}, not connected`)
  }
  const transport = opts.getTransport?.(opts.sessionId)
  if (!transport) throw new SessionNotConnectedError(opts.sessionId)
  return listGroups(transport, opts.sessionId)
}

// T20 — adicionar UM número a um grupo (ação manual do admin; sem lote, fila, timer ou IA).
export * from './participants'

export * from './invites'

export * from './automation'
export * from './web-model'
