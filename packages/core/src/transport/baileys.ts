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
  sendMessage(jid: string, content: Record<string, unknown>, options?: { ephemeralExpiration?: number }): Promise<{ key?: { id?: string | null } } | undefined>
  groupFetchAllParticipating(): Promise<Record<string, BaileysGroupLike>>
  requestPairingCode(phoneNumber: string): Promise<string>
  logout(msg?: string): Promise<void>
  end(error: Error | undefined): void | Promise<void>
  /** T20 — `groupParticipantsUpdate(jid, participants, 'add')`. Opcional nos mocks antigos. */
  groupParticipantsUpdate?(jid: string, participants: string[], action: 'add'): Promise<Array<{ status?: string; jid?: string }>>
  groupGetInviteInfo?(code: string): Promise<BaileysGroupLike & { desc?: string }>
  groupInviteCode?(jid: string): Promise<string | undefined>
  groupAcceptInvite?(code: string): Promise<string | undefined>
  sendPresenceUpdate?(type: 'composing' | 'paused', jid?: string): Promise<void>
  /** Pede ao celular o histórico sob demanda de uma conversa (a resposta chega em messaging-history.set). */
  fetchMessageHistory?(count: number, oldestMsgKey: { remoteJid: string; fromMe: boolean; id: string }, oldestMsgTimestamp: number): Promise<string>
  addOrEditContact?(jid: string, contact: { fullName?: string | null; firstName?: string | null }): Promise<void>
  /** WebSocket do Baileys: emite `CB:<tag>` para cada stanza recebida. */
  ws?: { on(event: string, listener: (node: BinaryNodeLike) => void): void }
  sendNode?(node: BinaryNodeLike): Promise<void>
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
  /** Entrada só com aprovação de um admin. */
  joinApprovalMode?: boolean
}

export type BaileysSocketConfig = UserFacingSocketConfig
export type BaileysSocketFactory = (config: BaileysSocketConfig) => BaileysSocketLike

/** Guarda, por conversa (JID), o tempo das mensagens temporárias em segundos (0 = desligado). */
export interface DisappearingStore {
  load(): Promise<Record<string, number>>
  save(jid: string, seconds: number): Promise<void>
}

export interface BaileysTransportOptions {
  /** Factory do socket; default: `makeWASocket` do Baileys (carregado sob demanda). */
  makeSocket?: BaileysSocketFactory
  /** Opções extras repassadas ao `makeWASocket` (ex.: logger, browser). */
  socketConfig?: Partial<Omit<BaileysSocketConfig, 'auth' | 'agent' | 'fetchAgent'>>
  /** Persistência dos tempos de mensagens temporárias (sobrevive a reinícios). Sem ela, só em memória. */
  disappearing?: DisappearingStore
  /** Guarda as figurinhas recebidas (de pessoas e grupos) para o aquecimento reaproveitar. */
  stickers?: { save(id: string, data: Buffer): Promise<void> }
  /** Baixa a mídia de uma mensagem recebida; default: `downloadMediaMessage` do Baileys. */
  downloadMedia?: (raw: unknown, sock: BaileysSocketLike) => Promise<Buffer>
  /** Validade da lista de grupos em cache (default GROUPS_CACHE_MS). */
  groupsCacheMs?: number
  /** Relógio (injetável em testes). */
  now?: () => number
}

/**
 * A lista de grupos (groupFetchAllParticipating) era pedida a cada minuto por chip, mais repasses e o painel:
 * o WhatsApp responde `rate-overlimit` e o ciclo de grupos falhava. Fica em cache e é invalidada quando a conta
 * entra/adiciona alguém ou o WhatsApp avisa mudança de grupo.
 */
export const GROUPS_CACHE_MS = 5 * 60_000

/** Intervalo mínimo entre duas conferências da mesma conversa no celular. */
export const CHAT_CHECK_INTERVAL = 6 * 3_600_000
/** Quanto esperar a resposta do celular numa conferência. */
export const CHAT_CHECK_WAIT = 8_000

/** Figurinha recebida aproveitável: até 1 MB; id estável (hash do arquivo) para não guardar repetida. */
export function receivedSticker(raw: { key?: { fromMe?: boolean | null } | null; message?: Record<string, unknown> | null }): string | undefined {
  const sticker = raw.message?.stickerMessage as { fileSha256?: Uint8Array | string; fileLength?: number | { toNumber(): number } } | undefined
  if (!sticker || raw.key?.fromMe) return undefined
  const length = typeof sticker.fileLength === 'number' ? sticker.fileLength : sticker.fileLength?.toNumber?.() ?? 0
  if (length > 1_000_000) return undefined
  const sha = sticker.fileSha256
  if (!sha) return undefined
  return (typeof sha === 'string' ? Buffer.from(sha, 'base64') : Buffer.from(sha)).toString('hex').slice(0, 32)
}

async function defaultDownloadMedia(raw: unknown): Promise<Buffer> {
  const mod = (await import('@whiskeysockets/baileys')) as unknown as {
    downloadMediaMessage: (msg: unknown, type: 'buffer', options: object) => Promise<Buffer>
  }
  // Sem pedido de reenvio: figurinha com mídia expirada só não é guardada.
  return mod.downloadMediaMessage(raw, 'buffer', {})
}

/** `contextInfo.expiration` de qualquer conteúdo da mensagem (mensagens em conversas temporárias o trazem). */
export function messageExpiration(content: Record<string, unknown> | null | undefined): number | undefined {
  for (const body of Object.values(content ?? {})) {
    const expiration = (body as { contextInfo?: { expiration?: unknown } } | null)?.contextInfo?.expiration
    if (typeof expiration === 'number' && expiration > 0) return expiration
  }
  return undefined
}

export interface BinaryNodeLike { tag: string; attrs: Record<string, string>; content?: unknown }

/** Ack de uma stanza no formato do WhatsApp Web (`<ack id to class [type] [participant]>`). */
export function ackFor(node: BinaryNodeLike): BinaryNodeLike {
  const attrs: Record<string, string> = { id: node.attrs.id ?? '', to: node.attrs.from ?? '', class: node.tag }
  if (node.attrs.type) attrs.type = node.attrs.type
  if (node.attrs.participant) attrs.participant = node.attrs.participant
  return { tag: 'ack', attrs }
}

interface ChatEphemeralLike { id?: string | null; pnJid?: string | null; lidJid?: string | null; ephemeralExpiration?: number | null }

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

/** `5511999999999:12@s.whatsapp.net` → `+5511999999999`. LIDs e formatos desconhecidos → undefined. */
export function phoneFromUserJid(jid: string | undefined): string | undefined {
  const match = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '')
  return match ? `+${match[1]}` : undefined
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
  /** JID (normalizado) → segundos das mensagens temporárias da conversa. */
  private readonly ephemeral = new Map<string, number>()
  private ephemeralLoad?: Promise<void>
  /** Última mensagem vista em cada conversa direta (âncora para pedir o histórico sob demanda ao celular). */
  private readonly lastKey = new Map<string, { id: string; fromMe: boolean; at: number }>()
  /** Quando cada conversa foi conferida pela última vez (evita pedir de novo a todo disparo). */
  private readonly checkedAt = new Map<string, number>()
  /** Conferências esperando a resposta do celular (resolvidas quando o histórico da conversa chega). */
  private readonly chatAnswer = new Map<string, () => void>()

  private groupsCache: { at: number; groups: GroupSummary[] } | undefined
  private groupsInFlight: Promise<GroupSummary[]> | undefined

  constructor(private readonly options: BaileysTransportOptions = {}) {
    super()
  }

  /** Atualiza o tempo das temporárias para todos os JIDs da conversa (telefone e LID). 0/null desliga. */
  private rememberEphemeral(jids: Array<string | null | undefined>, seconds: number | null | undefined) {
    const value = seconds && seconds > 0 ? seconds : 0
    for (const raw of jids) {
      if (!raw) continue
      const jid = normalizeJid(raw)
      if ((this.ephemeral.get(jid) ?? 0) === value) continue
      if (value) this.ephemeral.set(jid, value)
      else this.ephemeral.delete(jid)
      void this.options.disappearing?.save(jid, value).catch((err) => this.onListenerError(err, 'connection'))
    }
  }

  private rememberChats(chats: ChatEphemeralLike[] | undefined) {
    // Só conversas que trazem o campo: ausência não significa que as temporárias estão desligadas.
    for (const chat of chats ?? []) {
      if (chat && 'ephemeralExpiration' in chat) this.rememberEphemeral([chat.id, chat.pnJid, chat.lidJid], chat.ephemeralExpiration)
      // Resposta de uma conferência (com ou sem temporárias): libera quem estava esperando.
      for (const jid of [chat?.id, chat?.pnJid, chat?.lidJid]) {
        if (jid) this.chatAnswer.get(normalizeJid(jid))?.()
      }
    }
  }

  get isConnected(): boolean {
    return this.connected
  }

  async connect(opts: ConnectOptions): Promise<void> {
    if (this.sock) await this.close()
    this.ephemeralLoad ??= (async () => {
      const saved = (await this.options.disappearing?.load()) ?? {}
      for (const [jid, seconds] of Object.entries(saved)) if (seconds > 0 && !this.ephemeral.has(jid)) this.ephemeral.set(jid, seconds)
    })().catch((err) => { this.ephemeralLoad = undefined; this.onListenerError(err, 'connection') })

    const config: BaileysSocketConfig = { ...this.options.socketConfig, auth: opts.auth }
    if (opts.browser) config.browser = opts.browser
    if (opts.proxyUrl) {
      const agent = createProxyAgent(opts.proxyUrl)
      config.agent = agent
      config.fetchAgent = agent
    }

    const factory = this.options.makeSocket ?? (await defaultSocketFactory())
    const sock = factory(config)
    this.sock = sock
    this.invalidateGroups()
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
        // Mensagem com contextInfo.expiration: a conversa tem temporárias ligadas com esse tempo.
        for (const raw of u.messages ?? []) {
          if (u.type === 'notify') {
            // Âncora da conversa (pelo telefone e pelo LID) para conferir as temporárias no celular depois.
            const ts = raw.messageTimestamp
            const at = (typeof ts === 'number' ? ts : ts ? ts.toNumber() : Date.now() / 1000) * 1000
            this.rememberKey(raw.key?.remoteJidAlt, raw.key?.id, raw.key?.fromMe === true, at)
            this.rememberKey(raw.key?.remoteJid, raw.key?.id, raw.key?.fromMe === true, at)
          }
          const expiration = messageExpiration(raw.message)
          if (expiration) this.rememberEphemeral([raw.key?.remoteJid, raw.key?.remoteJidAlt], expiration)
          // Figurinha recebida: guarda o arquivo original (vira figurinha nativa ao reenviar). Falha não afeta nada.
          const stickerId = u.type === 'notify' ? receivedSticker(raw) : undefined
          if (stickerId && this.options.stickers) {
            const sink = this.options.stickers
            void (this.options.downloadMedia ?? defaultDownloadMedia)(raw, sock)
              .then((data) => sink.save(stickerId, data))
              .catch(() => undefined)
          }
        }
        if (u.type !== 'notify') return
        for (const raw of u.messages ?? []) {
          const msg = toIncomingMessage(raw)
          if (msg) this.emit('message', msg)
        }
      }),
    )

    // O servidor entrega stanzas <status> (atualização de recado) e espera ack. O Baileys não as trata: sem ack, o
    // servidor derruba a conexão (stream:error com <ack class="status">, código 500) e reentrega a mesma stanza no
    // próximo login, numa queda a cada ~50 min. Confirmamos como o WhatsApp Web faz.
    sock.ws?.on('CB:status', guard<BinaryNodeLike>(async (node) => {
      if (node.attrs?.id && node.attrs.from) await sock.sendNode?.(ackFor(node))
    }))

    // Ligar/desligar temporárias (inclusive pelo celular) chega como chats.update; o histórico inicial traz o estado.
    sock.ev.on('chats.upsert', guard<ChatEphemeralLike[]>((chats) => this.rememberChats(chats)))
    sock.ev.on('chats.update', guard<ChatEphemeralLike[]>((chats) => this.rememberChats(chats)))
    sock.ev.on('messaging-history.set', guard<{ chats?: ChatEphemeralLike[] }>((h) => this.rememberChats(h.chats)))
    // Mudança de grupo avisada pelo WhatsApp (entrou, saiu, nome, admins): a lista em cache deixa de valer.
    for (const event of ['groups.upsert', 'groups.update', 'group-participants.update']) sock.ev.on(event, guard(() => this.invalidateGroups()))

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
    await this.ephemeralLoad
    // Em conversa com temporárias, envia com o mesmo tempo (senão o WhatsApp avisa "Esta mensagem não desaparecerá").
    const ephemeralExpiration = this.ephemeral.get(normalizeJid(to))
    const result = ephemeralExpiration
      ? await sock.sendMessage(to, content as Record<string, unknown>, { ephemeralExpiration })
      : await sock.sendMessage(to, content as Record<string, unknown>)
    const messageId = result?.key?.id
    if (!messageId) throw new Error('Baileys não devolveu o ID da mensagem enviada')
    this.rememberKey(to, messageId, true, Date.now())
    return { messageId }
  }

  private rememberKey(jid: string | null | undefined, id: string | null | undefined, fromMe: boolean, at: number) {
    if (!jid || !id || !(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))) return
    this.lastKey.set(normalizeJid(jid), { id, fromMe, at })
  }

  /**
   * Conversa com tempo de temporárias desconhecido: pede ao celular o histórico sob demanda (1 mensagem, ancorada na
   * última vista); a resposta traz a configuração da conversa e é aprendida em messaging-history.set. No máximo uma
   * vez a cada CHAT_CHECK_INTERVAL por conversa; sem âncora (conversa nova) não há o que conferir.
   */
  async syncChatSettings(to: string): Promise<void> {
    try {
      await this.ephemeralLoad
      const jid = normalizeJid(to)
      const sock = this.sock
      if (this.ephemeral.has(jid) || !sock?.fetchMessageHistory || !this.connected) return
      if (Date.now() - (this.checkedAt.get(jid) ?? 0) < CHAT_CHECK_INTERVAL) return
      const anchor = this.lastKey.get(jid)
      if (!anchor) return
      this.checkedAt.set(jid, Date.now())
      const answered = new Promise<void>((resolve) => { this.chatAnswer.set(jid, resolve) })
      await sock.fetchMessageHistory(1, { remoteJid: jid, fromMe: anchor.fromMe, id: anchor.id }, anchor.at)
      // Espera a resposta do celular (até CHAT_CHECK_WAIT), para a próxima mensagem já sair com o tempo certo.
      await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, CHAT_CHECK_WAIT).unref?.())])
      this.chatAnswer.delete(jid)
    } catch (err) {
      this.onListenerError(err, 'connection')
    }
  }

  async sendTyping(to: string, typing: boolean): Promise<void> {
    await this.requireSocket().sendPresenceUpdate?.(typing ? 'composing' : 'paused', to)
  }

  async saveContact(jid: string, name: string): Promise<void> {
    const sock = this.requireSocket()
    if (!sock.addOrEditContact) return
    await sock.addOrEditContact(jid, { fullName: name })
  }

  ownPhone(): string | undefined {
    return phoneFromUserJid(this.connected ? this.sock?.user?.id : undefined)
  }

  async fetchGroups(): Promise<GroupSummary[]> {
    const sock = this.requireSocket()
    const now = this.options.now?.() ?? Date.now()
    const ttl = this.options.groupsCacheMs ?? GROUPS_CACHE_MS
    if (this.groupsCache && now - this.groupsCache.at < ttl) return this.groupsCache.groups.map((g) => ({ ...g }))
    this.groupsInFlight ??= (async () => {
      try {
        const groups = await sock.groupFetchAllParticipating()
        const own = new Set([sock.user?.id, sock.user?.lid].filter((v): v is string => typeof v === 'string').map(normalizeJid))
        const list = Object.values(groups).map((g) => toGroupSummary(g, own))
        this.groupsCache = { at: this.options.now?.() ?? Date.now(), groups: list }
        return list
      } catch (err) {
        // Limite do WhatsApp: a última lista boa vale mais que derrubar quem pediu (e pedir de novo piora o limite).
        if (this.groupsCache && /rate-overlimit/i.test(err instanceof Error ? err.message : String(err))) return this.groupsCache.groups
        throw err
      } finally {
        this.groupsInFlight = undefined
      }
    })()
    return (await this.groupsInFlight).map((g) => ({ ...g }))
  }

  private invalidateGroups(): void {
    this.groupsCache = undefined
  }

  async inspectGroupInvite(code: string): Promise<GroupSummary & { description?: string; joinApproval?: boolean }> {
    const sock = this.requireSocket()
    if (!sock.groupGetInviteInfo) throw new Error('groupGetInviteInfo not available')
    const group = await sock.groupGetInviteInfo(code)
    return { ...toGroupSummary(group), ...(group.desc ? { description: group.desc } : {}), ...(group.joinApprovalMode ? { joinApproval: true } : {}) }
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
    try {
      return await sock.groupAcceptInvite(code)
    } finally {
      this.invalidateGroups()
    }
  }

  /** T20 — adiciona UM participante (`groupParticipantsUpdate(..., 'add')`). Erros do grupo viram status. */
  async addGroupParticipant(groupId: string, jid: string): Promise<GroupParticipantResult[]> {
    const sock = this.requireSocket()
    if (!sock.groupParticipantsUpdate) throw new Error('groupParticipantsUpdate not available in this socket')
    let res: Array<{ status?: string; jid?: string }>
    try {
      res = await sock.groupParticipantsUpdate(groupId, [jid], 'add')
      this.invalidateGroups()
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
