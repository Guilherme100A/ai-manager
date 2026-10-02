// Contrato de transporte (SPEC T04): isola o Baileys atrás de uma interface testável.
import type { AuthenticationState } from '@whiskeysockets/baileys'

export type { AuthenticationState }

/** Motivo normalizado de desconexão (AC-T04-02). */
export type DisconnectKind = 'loggedOut' | 'forbidden' | 'transient'

export interface ConnectOptions {
  sessionId: string
  auth: AuthenticationState
  /** http://, https:// ou socks5:// (AC-T04-03). */
  proxyUrl?: string
  /** Se definido e a sessão ainda não estiver registrada, pede código de pareamento em vez de QR. */
  pairingPhone?: string
  /** Chamado quando o Baileys atualiza as credenciais (evento `creds.update`); persiste o auth state. */
  saveCreds?: () => Promise<void> | void
}

export interface ConnectionUpdate {
  state: 'open' | 'close'
  reason?: DisconnectKind
  statusCode?: number
}

export interface IncomingMessage {
  /** ID da mensagem no WhatsApp. */
  id: string
  /** JID do chat (contato ou grupo). */
  from: string
  /** JID alternativo (telefone quando o chat usa LID). */
  fromAlt?: string
  /** Autor dentro de um grupo. */
  participant?: string
  fromMe: boolean
  /** Epoch em milissegundos. */
  timestamp: number
  pushName?: string
  /** Texto (conversa, legenda ou texto estendido), quando houver. */
  text?: string
  /** Tipo do conteúdo (ex.: `conversation`, `imageMessage`). */
  type: string
}

export interface ReceiptUpdate {
  messageId: string
  status: 'delivered' | 'read'
}

export interface MediaRef {
  url: string
}

export type OutgoingContent =
  | { text: string }
  | { image: MediaRef; caption?: string; mimetype?: string }
  | { video: MediaRef; caption?: string; mimetype?: string }
  | { audio: MediaRef; mimetype?: string; ptt?: boolean }
  | { document: MediaRef; mimetype: string; fileName?: string; caption?: string }

export interface GroupSummary {
  id: string
  name: string
  /** Quantidade de participantes. */
  participants: number
  /** Somente admins enviam mensagens. */
  announce: boolean
  /** Grupo pertencente a uma comunidade (JID da comunidade). */
  communityId?: string
  /** T20 — a conta desta sessão é admin (ou superadmin) do grupo. */
  isAdmin?: boolean
}

/**
 * T20 — resultado por participante de addGroupParticipant, normalizado a partir do Baileys
 * (groupParticipantsUpdate 'add'): 200 → added, 409 → already_member, 403 por participante → not_allowed
 * (privacidade do número), erro do grupo 401/403 → not_admin, 404 → group_not_found, resto → failed.
 */
export type GroupParticipantStatus = 'added' | 'already_member' | 'not_admin' | 'group_not_found' | 'not_allowed' | 'failed'

export interface GroupParticipantResult {
  jid: string
  status: GroupParticipantStatus
  /** Código original do WhatsApp/Baileys, quando houver. */
  code?: number
}

export interface TransportEvents {
  qr: string
  'pairing-code': string
  connection: ConnectionUpdate
  message: IncomingMessage
  receipt: ReceiptUpdate
}

export type TransportEvent = keyof TransportEvents
export type TransportListener<E extends TransportEvent> = (payload: TransportEvents[E]) => void

export interface WaTransport {
  connect(opts: ConnectOptions): Promise<void>
  on(event: 'qr', cb: (qr: string) => void): void
  on(event: 'pairing-code', cb: (code: string) => void): void
  on(event: 'connection', cb: (u: ConnectionUpdate) => void): void
  on(event: 'message', cb: (m: IncomingMessage) => void): void
  on(event: 'receipt', cb: (r: ReceiptUpdate) => void): void
  sendMessage(to: string, content: OutgoingContent): Promise<{ messageId: string }>
  fetchGroups(): Promise<GroupSummary[]>
  inspectGroupInvite?(code: string): Promise<GroupSummary & { description?: string }>
  groupInviteCode?(groupId: string): Promise<string>
  groupAcceptInvite?(code: string): Promise<string | undefined>
  off?(event: 'message', cb: (message: IncomingMessage) => void): void
  /** T20 — adiciona UM participante a um grupo (ação manual do admin). Só lança TransportNotConnectedError. */
  addGroupParticipant(groupId: string, jid: string): Promise<GroupParticipantResult[]>
  logout(): Promise<void>
  close(): Promise<void>
}

export class TransportNotConnectedError extends Error {
  readonly code = 'TRANSPORT_NOT_CONNECTED'
  constructor(message = 'transporte não está conectado') {
    super(message)
    this.name = 'TransportNotConnectedError'
  }
}
