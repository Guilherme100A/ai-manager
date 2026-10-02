// FakeTransport: transporte em memória para testes (AC-T04-01). Nunca abre rede.
import { TransportEmitter } from './emitter'
import {
  TransportNotConnectedError,
  type ConnectOptions,
  type DisconnectKind,
  type GroupParticipantResult,
  type GroupSummary,
  type IncomingMessage,
  type OutgoingContent,
  type WaTransport,
} from './types'

export interface FakeSentMessage {
  messageId: string
  to: string
  content: OutgoingContent
  at: Date
}

/** Grupo simulado: `members` (JIDs) permite simular "já é membro" (T20). */
export type FakeGroup = GroupSummary & { members?: string[] }

export type FakeIncomingInput = Partial<IncomingMessage> & { from: string }

export class FakeTransport extends TransportEmitter implements WaTransport {
  /** Envios bem-sucedidos, em ordem. */
  readonly sent: FakeSentMessage[] = []
  /** Opções de cada chamada a `connect`. */
  readonly connectCalls: ConnectOptions[] = []
  /** Grupos devolvidos por `fetchGroups`. */
  groups: FakeGroup[] = []
  /** Chamadas a addGroupParticipant, em ordem (T20). */
  readonly groupAdds: Array<{ groupId: string; jid: string }> = []
  private readonly groupAddFailures: Error[] = []

  connected = false
  loggedOut = false
  closed = false

  private readonly sendFailures: Error[] = []
  private seq = 0

  get lastConnect(): ConnectOptions | undefined {
    return this.connectCalls.at(-1)
  }

  async connect(opts: ConnectOptions): Promise<void> {
    this.connectCalls.push(opts)
    this.closed = false
    this.loggedOut = false
  }

  // ---- helpers de simulação -------------------------------------------------

  emitQr(qr = `fake-qr-${++this.seq}`): void {
    this.emit('qr', qr)
  }

  emitPairingCode(code = 'FAKE1234'): void {
    this.emit('pairing-code', code)
  }

  /** Simula conexão aberta. */
  open(): void {
    this.connected = true
    this.emit('connection', { state: 'open' })
  }

  /**
   * Com `reason`: simula queda da conexão vinda do WhatsApp (emite `connection` close).
   * Sem argumentos: é o `close()` da interface (encerramento local, sem evento).
   */
  async close(reason?: DisconnectKind, statusCode?: number): Promise<void> {
    this.connected = false
    if (reason === undefined) {
      this.closed = true
      return
    }
    if (reason === 'loggedOut') this.loggedOut = true
    this.emit('connection', statusCode === undefined ? { state: 'close', reason } : { state: 'close', reason, statusCode })
  }

  /** Simula mensagem recebida; campos ausentes recebem defaults. Devolve a mensagem emitida. */
  receive(msg: FakeIncomingInput): IncomingMessage {
    const full: IncomingMessage = {
      id: `FAKE-IN-${++this.seq}`,
      fromMe: false,
      timestamp: Date.now(),
      type: 'conversation',
      ...msg,
    }
    this.emit('message', full)
    return full
  }

  receipt(messageId: string, status: 'delivered' | 'read'): void {
    this.emit('receipt', { messageId, status })
  }

  /** O próximo `sendMessage` rejeita com `err` (uma vez por chamada). */
  failNextSend(err: Error = new Error('fake send failure')): void {
    this.sendFailures.push(err)
  }

  setGroups(groups: FakeGroup[]): void {
    this.groups = groups
  }

  /** O próximo addGroupParticipant lança `err` (erro inesperado do transporte). */
  failNextGroupAdd(err: Error = new Error('fake group add failure')): void {
    this.groupAddFailures.push(err)
  }

  // ---- WaTransport ------------------------------------------------------------

  async sendMessage(to: string, content: OutgoingContent): Promise<{ messageId: string }> {
    const failure = this.sendFailures.shift()
    if (failure) throw failure
    if (!this.connected) throw new TransportNotConnectedError()
    const messageId = `FAKE-OUT-${++this.seq}`
    this.sent.push({ messageId, to, content, at: new Date() })
    return { messageId }
  }

  async fetchGroups(): Promise<GroupSummary[]> {
    if (!this.connected) throw new TransportNotConnectedError()
    return this.groups.map(({ members: _members, ...g }) => ({ ...g }))
  }

  /** T20: grupo inexistente, não admin, já membro ou adicionado (inclui o jid em members e soma 1 em participants). */
  async addGroupParticipant(groupId: string, jid: string): Promise<GroupParticipantResult[]> {
    if (!this.connected) throw new TransportNotConnectedError()
    this.groupAdds.push({ groupId, jid })
    const failure = this.groupAddFailures.shift()
    if (failure) throw failure
    const group = this.groups.find((g) => g.id === groupId)
    if (!group) return [{ jid, status: 'group_not_found', code: 404 }]
    if (!group.isAdmin) return [{ jid, status: 'not_admin', code: 403 }]
    if (group.members?.includes(jid)) return [{ jid, status: 'already_member', code: 409 }]
    group.members = [...(group.members ?? []), jid]
    group.participants += 1
    return [{ jid, status: 'added', code: 200 }]
  }

  /** Número da conta "autenticada" (testes); devolvido por ownPhone() enquanto conectado. */
  phone: string | undefined

  ownPhone(): string | undefined {
    return this.connected ? this.phone : undefined
  }

  async logout(): Promise<void> {
    await this.close('loggedOut', 401)
  }
}
