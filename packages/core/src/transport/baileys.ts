// BaileysTransport: adaptador do @whiskeysockets/baileys para WaTransport.
// O socket é criado por uma factory injetável, para testes sem rede (AC-T04-02/03).
import type { Agent } from 'node:https'
import type { UserFacingSocketConfig } from '@whiskeysockets/baileys'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { TransportEmitter } from './emitter'
import {
  TransportNotConnectedError,
  type ConnectOptions,
  type DisconnectKind,
  type GroupParticipantResult,
  type GroupParticipantStatus,
  type GroupSummary,
  type IncomingMessage,
  type OutgoingContent,
  type WaTransport,
} from './types'

/** Códigos do `DisconnectReason` do Baileys usados no mapeamento. */
export const BAILEYS_DISCONNECT = { loggedOut: 401, forbidden: 403 } as const

/** Status de `proto.WebMessageInfo.Status` usados nos recibos. */
const MESSAGE_STATUS = { DELIVERY_ACK: 3, READ: 4, PLAYED: 5 } as const

/** AC-T04-02: loggedOut (401) → loggedOut, 403 → forbidden, o resto → transient. */
export function mapDisconnectReason(statusCode: number | undefined): DisconnectKind {
  if (statusCode === BAILEYS_DISCONNECT.loggedOut) return 'loggedOut'
  if (statusCode === BAILEYS_DISCONNECT.forbidden) return 'forbidden'
  return 'transient'
}

/** Extrai o statusCode de um erro Boom (`error.output.statusCode`) do Baileys. */
export function disconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const output = (error as { output?: { statusCode?: unknown } }).output
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined
}

export class UnsupportedProxyError extends Error {
  constructor(proxyUrl: string) {
    super(`protocolo de proxy não suportado: ${redactProxyUrl(proxyUrl)} (use http, https ou socks5)`)
    this.name = 'UnsupportedProxyError'
  }
}

/** Remove usuário/senha da URL do proxy para uso em mensagens e logs. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl)
    if (url.username || url.password) {
      url.username = '***'
      url.password = ''
    }
    return url.toString()
  } catch {
    return '<proxy inválido>'
  }
}

/** AC-T04-03: cria o agente para http/https (CONNECT) ou socks5. */
export function createProxyAgent(proxyUrl: string): Agent {
  let protocol: string
  try {
    protocol = new URL(proxyUrl).protocol
  } catch {
    throw new UnsupportedProxyError(proxyUrl)
  }
  switch (protocol) {
    case 'http:':
    case 'https:':
      return new HttpsProxyAgent(proxyUrl)
    case 'socks5:':
    case 'socks5h:':
      return new SocksProxyAgent(proxyUrl)
    default:
      throw new UnsupportedProxyError(proxyUrl)
  }
}

type EventHandler = (payload: unknown) => void

/** Subconjunto do socket do Baileys usado pelo transporte (facilita mocks). */
export interface BaileysSocketLike {
  ev: { on(event: string, listener: EventHandler): void }
  sendMessage(jid: string, content: Record<string, unknown>): Promise<{ key?: { id?: string | null } } | undefined>
  groupFetchAllParticipating(): Promise<Record<string, BaileysGroupLike>>
  requestPairingCode(phoneNumber: string): Promise<string>
  logout(msg?: string): Promise<void>
  end(error: Error | undefined): void | Promise<void>
  /** T20 — `groupParticipantsUpdate(jid, participants, 'add')`. Opcional nos mocks antigos. */
  groupParticipantsUpdate?(jid: string, participants: string[], action: 'add'): Promise<Array<{ status?: string; jid?: string }>>
  groupGetInviteInfo?(code: string): Promise<BaileysGroupLike & { desc?: string }>
  groupInviteCode?(jid: string): Promise<string | undefined>
  groupAcceptInvite?(code: string): Promise<string | undefined>
  /** Conta autenticada (para saber se é admin dos grupos). */
  user?: { id?: string; lid?: string } | null
}

/** Participante de grupo no formato do Baileys (`GroupParticipant`). */
export interface BaileysGroupParticipantLike {
  id?: string
  lid?: string
  phoneNumber?: string
  admin?: 'admin' | 'superadmin' | null
  isAdmin?: boolean
  isSuperAdmin?: boolean
}

export interface BaileysGroupLike {
  id: string
  subject?: string
  size?: number
  participants?: unknown[]
  announce?: boolean
  linkedParent?: string
}

export type BaileysSocketConfig = UserFacingSocketConfig
export type BaileysSocketFactory = (config: BaileysSocketConfig) => BaileysSocketLike

export interface BaileysTransportOptions {
  /** Factory do socket; default: `makeWASocket` do Baileys (carregado sob demanda). */
  makeSocket?: BaileysSocketFactory
  /** Opções extras repassadas ao `makeWASocket` (ex.: logger, browser). */
  socketConfig?: Partial<Omit<BaileysSocketConfig, 'auth' | 'agent' | 'fetchAgent'>>
}

async function defaultSocketFactory(): Promise<BaileysSocketFactory> {
  const mod = await import('@whiskeysockets/baileys')
  return mod.makeWASocket as unknown as BaileysSocketFactory
}

interface RawMessage {
  key?: { id?: string | null; remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null; participant?: string | null }
  message?: Record<string, unknown> | null
  messageTimestamp?: number | { toNumber(): number } | null
  pushName?: string | null
}

const IGNORED_CONTENT_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage'])

/** Converte uma `WAMessage` do Baileys em `IncomingMessage`; devolve `undefined` se não houver conteúdo. */
export function toIncomingMessage(raw: RawMessage): IncomingMessage | undefined {
  const id = raw.key?.id
  const from = raw.key?.remoteJid
  const content = raw.message
  if (!id || !from || !content) return undefined
  const type = Object.keys(content).find((k) => !IGNORED_CONTENT_KEYS.has(k) && content[k] != null)
  if (!type) return undefined

  const body = content[type]
  let text: string | undefined
  if (typeof body === 'string') text = body
  else if (body && typeof body === 'object') {
    const b = body as { text?: unknown; caption?: unknown }
    if (typeof b.text === 'string') text = b.text
    else if (typeof b.caption === 'string') text = b.caption
  }

  const ts = raw.messageTimestamp
  const seconds = typeof ts === 'number' ? ts : ts ? ts.toNumber() : undefined

  const msg: IncomingMessage = {
    id,
    from,
    fromMe: raw.key?.fromMe === true,
    timestamp: seconds !== undefined ? seconds * 1000 : Date.now(),
    type,
  }
  if (raw.key?.remoteJidAlt) msg.fromAlt = raw.key.remoteJidAlt
  if (raw.key?.participant) msg.participant = raw.key.participant
  if (raw.pushName) msg.pushName = raw.pushName
  if (text !== undefined) msg.text = text
  return msg
}

/** JID sem o sufixo de dispositivo (`5511...:12@s.whatsapp.net` → `5511...@s.whatsapp.net`). */
export function normalizeJid(jid: string): string {
  return jid.replace(/:\d+@/, '@')
}

/** A conta (ids próprios) é admin/superadmin do grupo? */
export function isGroupAdmin(participants: unknown[] | undefined, ownIds: ReadonlySet<string>): boolean {
  if (!participants || ownIds.size === 0) return false
  return participants.some((raw) => {
    const p = raw as BaileysGroupParticipantLike
    const ids = [p.id, p.lid, p.phoneNumber].filter((v): v is string => typeof v === 'string').map(normalizeJid)
    if (!ids.some((id) => ownIds.has(id))) return false
    return p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true
  })
}

function toGroupSummary(g: BaileysGroupLike, ownIds: ReadonlySet<string> = new Set()): GroupSummary {
  const summary: GroupSummary = {
    id: g.id,
    name: g.subject ?? '',
    participants: g.size ?? g.participants?.length ?? 0,
    announce: g.announce === true,
    isAdmin: isGroupAdmin(g.participants, ownIds),
  }
  if (g.linkedParent) summary.communityId = g.linkedParent
  return summary
}

/** T20 — código do Baileys por participante → status normalizado. */
export function mapParticipantStatus(code: number | undefined): GroupParticipantStatus {
  if (code === 200) return 'added'
  if (code === 409) return 'already_member'
  if (code === 403) return 'not_allowed'
  if (code === 404) return 'group_not_found'
  return 'failed'
}

/** T20 — erro do grupo inteiro (IQ de erro) → status normalizado: 404 item-not-found, 401/403 sem permissão de admin. */
export function mapGroupErrorStatus(code: number | undefined): GroupParticipantStatus {
  if (code === 404) return 'group_not_found'
  if (code === 401 || code === 403) return 'not_admin'
  return 'failed'
}

export class BaileysTransport extends TransportEmitter implements WaTransport {
  private sock: BaileysSocketLike | undefined
  private connected = false

  constructor(private readonly options: BaileysTransportOptions = {}) {
    super()
  }

  get isConnected(): boolean {
    return this.connected
  }

  async connect(opts: ConnectOptions): Promise<void> {
    if (this.sock) await this.close()

    const config: BaileysSocketConfig = { ...this.options.socketConfig, auth: opts.auth }
    if (opts.proxyUrl) {
      const agent = createProxyAgent(opts.proxyUrl)
      config.agent = agent
      config.fetchAgent = agent
    }

    const factory = this.options.makeSocket ?? (await defaultSocketFactory())
    const sock = factory(config)
    this.sock = sock
    let pairingRequested = false

    // Eventos de um socket substituído/encerrado são ignorados.
    const guard =
      <T>(fn: (payload: T) => void | Promise<void>): EventHandler =>
      (payload) => {
        if (this.sock !== sock) return
        void Promise.resolve(fn(payload as T)).catch((err) => this.onListenerError(err, 'connection'))
      }

    sock.ev.on(
      'connection.update',
      guard<{ connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }>(async (u) => {
        if (u.qr) {
          if (opts.pairingPhone && !opts.auth.creds.registered) {
            if (!pairingRequested) {
              pairingRequested = true
              const code = await sock.requestPairingCode(opts.pairingPhone.replace(/\D/g, ''))
              if (this.sock === sock) this.emit('pairing-code', code)
            }
          } else {
            this.emit('qr', u.qr)
          }
        }
        if (u.connection === 'open') {
          this.connected = true
          this.emit('connection', { state: 'open' })
        } else if (u.connection === 'close') {
          this.connected = false
          this.sock = undefined
          const statusCode = disconnectStatusCode(u.lastDisconnect?.error)
          const reason = mapDisconnectReason(statusCode)
          this.emit('connection', statusCode === undefined ? { state: 'close', reason } : { state: 'close', reason, statusCode })
        }
      }),
    )

    if (opts.saveCreds) {
      const save = opts.saveCreds
      sock.ev.on('creds.update', guard(() => save()))
    }

    sock.ev.on(
      'messages.upsert',
      guard<{ messages?: RawMessage[]; type?: string }>((u) => {
        if (u.type !== 'notify') return
        for (const raw of u.messages ?? []) {
          const msg = toIncomingMessage(raw)
          if (msg) this.emit('message', msg)
        }
      }),
    )

    sock.ev.on(
      'messages.update',
      guard<Array<{ key?: { id?: string | null; fromMe?: boolean | null }; update?: { status?: number | null } }>>(
        (updates) => {
          for (const { key, update } of updates) {
            if (!key?.id || !key.fromMe) continue
            const s = update?.status
            if (s === MESSAGE_STATUS.DELIVERY_ACK) this.emit('receipt', { messageId: key.id, status: 'delivered' })
            else if (s === MESSAGE_STATUS.READ || s === MESSAGE_STATUS.PLAYED)
              this.emit('receipt', { messageId: key.id, status: 'read' })
          }
        },
      ),
    )
  }

  private requireSocket(): BaileysSocketLike {
    if (!this.sock || !this.connected) throw new TransportNotConnectedError()
    return this.sock
  }

  async sendMessage(to: string, content: OutgoingContent): Promise<{ messageId: string }> {
    const sock = this.requireSocket()
    const result = await sock.sendMessage(to, content as Record<string, unknown>)
    const messageId = result?.key?.id
    if (!messageId) throw new Error('Baileys não devolveu o ID da mensagem enviada')
    return { messageId }
  }

  async fetchGroups(): Promise<GroupSummary[]> {
    const groups = await this.requireSocket().groupFetchAllParticipating()
    const own = new Set([this.sock?.user?.id, this.sock?.user?.lid].filter((v): v is string => typeof v === 'string').map(normalizeJid))
    return Object.values(groups).map((g) => toGroupSummary(g, own))
  }

  async inspectGroupInvite(code: string): Promise<GroupSummary & { description?: string }> {
    const sock = this.requireSocket()
    if (!sock.groupGetInviteInfo) throw new Error('groupGetInviteInfo not available')
    const group = await sock.groupGetInviteInfo(code)
    return { ...toGroupSummary(group), ...(group.desc ? { description: group.desc } : {}) }
  }

  async groupInviteCode(groupId: string): Promise<string> {
    const sock = this.requireSocket()
    if (!sock.groupInviteCode) throw new Error('groupInviteCode not available')
    const code = await sock.groupInviteCode(groupId)
    if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('invalid group invite code')
    return code
  }

  async groupAcceptInvite(code: string): Promise<string | undefined> {
    const sock = this.requireSocket()
    if (!sock.groupAcceptInvite) throw new Error('groupAcceptInvite not available')
    return sock.groupAcceptInvite(code)
  }

  /** T20 — adiciona UM participante (`groupParticipantsUpdate(..., 'add')`). Erros do grupo viram status. */
  async addGroupParticipant(groupId: string, jid: string): Promise<GroupParticipantResult[]> {
    const sock = this.requireSocket()
    if (!sock.groupParticipantsUpdate) throw new Error('groupParticipantsUpdate not available in this socket')
    let res: Array<{ status?: string; jid?: string }>
    try {
      res = await sock.groupParticipantsUpdate(groupId, [jid], 'add')
    } catch (err) {
      const code = disconnectStatusCode(err) ?? numericData(err)
      const out: GroupParticipantResult = { jid, status: mapGroupErrorStatus(code) }
      if (code !== undefined) out.code = code
      return [out]
    }
    if (!res?.length) return [{ jid, status: 'failed' }]
    return res.map((r) => {
      const code = r.status !== undefined && /^\d+$/.test(r.status) ? Number(r.status) : undefined
      const out: GroupParticipantResult = { jid: r.jid ?? jid, status: mapParticipantStatus(code) }
      if (code !== undefined) out.code = code
      return out
    })
  }

  /** Desloga o dispositivo; o Baileys emite `connection` close com reason `loggedOut`. */
  async logout(): Promise<void> {
    const sock = this.sock
    if (!sock) throw new TransportNotConnectedError()
    await sock.logout()
  }

  /** Encerra o socket localmente, sem deslogar e sem emitir eventos. */
  async close(): Promise<void> {
    const sock = this.sock
    this.sock = undefined
    this.connected = false
    if (sock) await sock.end(undefined)
  }
}

/** Código numérico em `error.data` (algumas versões do Baileys guardam o código do IQ ali). */
function numericData(err: unknown): number | undefined {
  const data = (err as { data?: unknown } | null)?.data
  if (typeof data === 'number') return data
  const n = Number((data as { code?: unknown } | null | undefined)?.code)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
