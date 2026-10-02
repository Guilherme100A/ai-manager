import { EventEmitter } from 'node:events'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { describe, expect, it, vi } from 'vitest'
import {
  BaileysTransport,
  UnsupportedProxyError,
  createProxyAgent,
  mapDisconnectReason,
  redactProxyUrl,
  toIncomingMessage,
  type BaileysSocketConfig,
  type BaileysSocketLike,
} from './baileys'
import { TransportNotConnectedError, type AuthenticationState, type ConnectionUpdate } from './types'

const boom = (statusCode: number) => Object.assign(new Error('closed'), { output: { statusCode } })

function mockSocket() {
  const ev = new EventEmitter()
  const sock = {
    ev,
    sendMessage: vi.fn(async () => ({ key: { id: 'WAMID-1' } })),
    groupFetchAllParticipating: vi.fn(async () => ({
      'g1@g.us': { id: 'g1@g.us', subject: 'Grupo 1', size: 5, announce: true, linkedParent: 'c@g.us' },
      'g2@g.us': { id: 'g2@g.us', subject: 'Grupo 2', participants: [{}, {}] },
    })),
    groupInviteCode: vi.fn(async () => 'TEST_CODE'),
    groupGetInviteInfo: vi.fn(async () => ({ id: 'g1@g.us', subject: 'Grupo 1', desc: 'Tema do grupo', size: 5 })),
    groupAcceptInvite: vi.fn(async () => 'g1@g.us'),
    requestPairingCode: vi.fn(async () => 'PAIR1234'),
    logout: vi.fn(async () => {
      ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: boom(401) } })
    }),
    end: vi.fn(),
  } satisfies BaileysSocketLike
  return sock
}

function setup(registered = false) {
  const configs: BaileysSocketConfig[] = []
  const sockets: ReturnType<typeof mockSocket>[] = []
  const transport = new BaileysTransport({
    makeSocket: (config) => {
      configs.push(config)
      const s = mockSocket()
      sockets.push(s)
      return s
    },
  })
  const auth = { creds: { registered }, keys: {} } as unknown as AuthenticationState
  return { transport, configs, sockets, auth }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('mapDisconnectReason (AC-T04-02)', () => {
  it('401 (DisconnectReason.loggedOut) → loggedOut', () => expect(mapDisconnectReason(401)).toBe('loggedOut'))
  it('403 → forbidden', () => expect(mapDisconnectReason(403)).toBe('forbidden'))
  it.each([408, 428, 440, 500, 503, 515, 411, undefined])('%s → transient', (code) =>
    expect(mapDisconnectReason(code)).toBe('transient'),
  )
})

describe('createProxyAgent (AC-T04-03)', () => {
  it('http/https → HttpsProxyAgent', () => {
    expect(createProxyAgent('http://u:p@proxy:8080')).toBeInstanceOf(HttpsProxyAgent)
    expect(createProxyAgent('https://proxy:8443')).toBeInstanceOf(HttpsProxyAgent)
  })
  it('socks5 → SocksProxyAgent', () => {
    expect(createProxyAgent('socks5://u:p@proxy:1080')).toBeInstanceOf(SocksProxyAgent)
  })
  it('protocolo desconhecido ou URL inválida → UnsupportedProxyError sem vazar senha', () => {
    expect(() => createProxyAgent('ftp://u:segredo@proxy:21')).toThrow(UnsupportedProxyError)
    expect(() => createProxyAgent('ftp://u:segredo@proxy:21')).not.toThrow(/segredo/)
    expect(() => createProxyAgent('nada')).toThrow(UnsupportedProxyError)
  })
  it('redactProxyUrl remove credenciais', () => {
    expect(redactProxyUrl('socks5://user:pass@host:1080')).not.toMatch(/pass|user/)
  })
})

describe('BaileysTransport', () => {
  it('convites usam o socket conectado e preservam o código e o grupo retornado', async () => {
    const { transport, sockets, auth } = setup()
    await expect(transport.groupAcceptInvite('TEST_CODE')).rejects.toBeInstanceOf(TransportNotConnectedError)
    await transport.connect({ sessionId: 's', auth })
    sockets[0]!.ev.emit('connection.update', { connection: 'open' })
    await expect(transport.groupInviteCode('g1@g.us')).resolves.toBe('TEST_CODE')
    await expect(transport.inspectGroupInvite('TEST_CODE')).resolves.toMatchObject({ id: 'g1@g.us', name: 'Grupo 1', description: 'Tema do grupo' })
    await expect(transport.groupAcceptInvite('TEST_CODE')).resolves.toBe('g1@g.us')
    expect(sockets[0]!.groupInviteCode).toHaveBeenCalledWith('g1@g.us')
    expect(sockets[0]!.groupAcceptInvite).toHaveBeenCalledWith('TEST_CODE')
    expect(toIncomingMessage({ key: { id: 'm', remoteJid: '123@lid', remoteJidAlt: '5511@s.whatsapp.net' }, message: { conversation: 'oi' } })).toMatchObject({ fromAlt: '5511@s.whatsapp.net' })
  })
  it('sem proxyUrl não passa agent nem fetchAgent', async () => {
    const { transport, configs, auth } = setup()
    await transport.connect({ sessionId: 's', auth })
    expect(configs[0]!.auth).toBe(auth)
    expect(configs[0]).not.toHaveProperty('agent')
    expect(configs[0]).not.toHaveProperty('fetchAgent')
  })

  it.each([
    ['http://proxy:8080', HttpsProxyAgent],
    ['https://proxy:8443', HttpsProxyAgent],
    ['socks5://proxy:1080', SocksProxyAgent],
  ])('com proxyUrl %s passa o agente em agent e fetchAgent', async (proxyUrl, cls) => {
    const { transport, configs, auth } = setup()
    await transport.connect({ sessionId: 's', auth, proxyUrl })
    expect(configs[0]!.agent).toBeInstanceOf(cls)
    expect(configs[0]!.fetchAgent).toBe(configs[0]!.agent)
  })

  it('mapeia connection.update open/close com o DisconnectReason', async () => {
    const { transport, sockets, auth } = setup()
    const updates: ConnectionUpdate[] = []
    transport.on('connection', (u) => updates.push(u))
    for (const code of [401, 403, 515]) {
      await transport.connect({ sessionId: 's', auth })
      const ev = sockets.at(-1)!.ev
      ev.emit('connection.update', { connection: 'open' })
      ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: boom(code) } })
    }
    await transport.connect({ sessionId: 's', auth })
    sockets.at(-1)!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Error('x') } })
    await flush()
    expect(updates.filter((u) => u.state === 'close')).toEqual([
      { state: 'close', reason: 'loggedOut', statusCode: 401 },
      { state: 'close', reason: 'forbidden', statusCode: 403 },
      { state: 'close', reason: 'transient', statusCode: 515 },
      { state: 'close', reason: 'transient' },
    ])
    expect(updates.filter((u) => u.state === 'open')).toHaveLength(3)
  })

  it('emite qr quando não há pairingPhone', async () => {
    const { transport, sockets, auth } = setup()
    const qr = vi.fn()
    transport.on('qr', qr)
    await transport.connect({ sessionId: 's', auth })
    sockets[0]!.ev.emit('connection.update', { qr: 'QR-DATA' })
    await flush()
    expect(qr).toHaveBeenCalledWith('QR-DATA')
  })

  it('com pairingPhone pede o código uma vez e emite pairing-code em vez de qr', async () => {
    const { transport, sockets, auth } = setup(false)
    const qr = vi.fn()
    const code = vi.fn()
    transport.on('qr', qr)
    transport.on('pairing-code', code)
    await transport.connect({ sessionId: 's', auth, pairingPhone: '+55 (11) 99999-9999' })
    sockets[0]!.ev.emit('connection.update', { qr: 'Q1' })
    sockets[0]!.ev.emit('connection.update', { qr: 'Q2' })
    await flush()
    expect(sockets[0]!.requestPairingCode).toHaveBeenCalledTimes(1)
    expect(sockets[0]!.requestPairingCode).toHaveBeenCalledWith('5511999999999')
    expect(code).toHaveBeenCalledWith('PAIR1234')
    expect(qr).not.toHaveBeenCalled()
  })

  it('creds.update chama saveCreds', async () => {
    const { transport, sockets, auth } = setup()
    const saveCreds = vi.fn()
    await transport.connect({ sessionId: 's', auth, saveCreds })
    sockets[0]!.ev.emit('creds.update', {})
    await flush()
    expect(saveCreds).toHaveBeenCalledTimes(1)
  })

  it('messages.upsert (notify) vira message; append é ignorado', async () => {
    const { transport, sockets, auth } = setup()
    const onMsg = vi.fn()
    transport.on('message', onMsg)
    await transport.connect({ sessionId: 's', auth })
    const raw = {
      key: { id: 'M1', remoteJid: '5511@s.whatsapp.net', fromMe: false },
      message: { conversation: 'olá' },
      messageTimestamp: 1_700_000_000,
      pushName: 'Ana',
    }
    sockets[0]!.ev.emit('messages.upsert', { type: 'append', messages: [raw] })
    sockets[0]!.ev.emit('messages.upsert', { type: 'notify', messages: [raw, { key: { id: 'M2' } }] })
    await flush()
    expect(onMsg).toHaveBeenCalledTimes(1)
    expect(onMsg).toHaveBeenCalledWith({
      id: 'M1',
      from: '5511@s.whatsapp.net',
      fromMe: false,
      timestamp: 1_700_000_000_000,
      pushName: 'Ana',
      text: 'olá',
      type: 'conversation',
    })
  })

  it('messages.update com status vira receipt (só mensagens próprias)', async () => {
    const { transport, sockets, auth } = setup()
    const onReceipt = vi.fn()
    transport.on('receipt', onReceipt)
    await transport.connect({ sessionId: 's', auth })
    sockets[0]!.ev.emit('messages.update', [
      { key: { id: 'A', fromMe: true }, update: { status: 3 } },
      { key: { id: 'B', fromMe: true }, update: { status: 4 } },
      { key: { id: 'C', fromMe: true }, update: { status: 5 } },
      { key: { id: 'D', fromMe: true }, update: { status: 2 } },
      { key: { id: 'E', fromMe: false }, update: { status: 4 } },
    ])
    await flush()
    expect(onReceipt.mock.calls).toEqual([
      [{ messageId: 'A', status: 'delivered' }],
      [{ messageId: 'B', status: 'read' }],
      [{ messageId: 'C', status: 'read' }],
    ])
  })

  it('sendMessage exige conexão aberta e devolve o ID do Baileys', async () => {
    const { transport, sockets, auth } = setup()
    await expect(transport.sendMessage('x@s.whatsapp.net', { text: 'a' })).rejects.toBeInstanceOf(
      TransportNotConnectedError,
    )
    await transport.connect({ sessionId: 's', auth })
    await expect(transport.sendMessage('x@s.whatsapp.net', { text: 'a' })).rejects.toBeInstanceOf(
      TransportNotConnectedError,
    )
    sockets[0]!.ev.emit('connection.update', { connection: 'open' })
    await flush()
    await expect(transport.sendMessage('x@s.whatsapp.net', { text: 'a' })).resolves.toEqual({ messageId: 'WAMID-1' })
    expect(sockets[0]!.sendMessage).toHaveBeenCalledWith('x@s.whatsapp.net', { text: 'a' })
  })

  it('fetchGroups resume os grupos', async () => {
    const { transport, sockets, auth } = setup()
    await transport.connect({ sessionId: 's', auth })
    sockets[0]!.ev.emit('connection.update', { connection: 'open' })
    await flush()
    await expect(transport.fetchGroups()).resolves.toEqual([
      { id: 'g1@g.us', name: 'Grupo 1', participants: 5, announce: true, communityId: 'c@g.us', isAdmin: false },
      { id: 'g2@g.us', name: 'Grupo 2', participants: 2, announce: false, isAdmin: false },
    ])
  })

  it('logout emite close loggedOut; close() encerra sem evento e ignora eventos do socket antigo', async () => {
    const { transport, sockets, auth } = setup()
    const conn = vi.fn()
    transport.on('connection', conn)
    await transport.connect({ sessionId: 's', auth })
    sockets[0]!.ev.emit('connection.update', { connection: 'open' })
    await flush()
    await transport.logout()
    await flush()
    expect(conn).toHaveBeenLastCalledWith({ state: 'close', reason: 'loggedOut', statusCode: 401 })

    conn.mockClear()
    await transport.connect({ sessionId: 's', auth })
    await transport.close()
    expect(sockets[1]!.end).toHaveBeenCalledWith(undefined)
    sockets[1]!.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: boom(428) } })
    await flush()
    expect(conn).not.toHaveBeenCalled()
    expect(transport.isConnected).toBe(false)
  })

  it('reconectar encerra o socket anterior', async () => {
    const { transport, sockets, auth } = setup()
    await transport.connect({ sessionId: 's', auth })
    await transport.connect({ sessionId: 's', auth })
    expect(sockets[0]!.end).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(2)
  })
})

describe('toIncomingMessage', () => {
  it('extrai legenda e texto estendido; ignora messageContextInfo', () => {
    expect(
      toIncomingMessage({
        key: { id: 'I', remoteJid: 'g@g.us', participant: 'p@s.whatsapp.net' },
        message: { messageContextInfo: {}, imageMessage: { caption: 'foto' } },
        messageTimestamp: { toNumber: () => 10 },
      }),
    ).toMatchObject({ id: 'I', type: 'imageMessage', text: 'foto', participant: 'p@s.whatsapp.net', timestamp: 10_000 })
    expect(
      toIncomingMessage({ key: { id: 'E', remoteJid: 'a@s' }, message: { extendedTextMessage: { text: 'link' } } }),
    ).toMatchObject({ type: 'extendedTextMessage', text: 'link' })
  })
})

describe('factory padrão', () => {
  it('o pacote do Baileys expõe makeWASocket (sem abrir socket)', async () => {
    const mod = await import('@whiskeysockets/baileys')
    expect(typeof mod.makeWASocket).toBe('function')
  })
})
