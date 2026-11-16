// Integração CRM (A2/A3/A4/A7) no transporte: mídia/citação/anúncio no IncomingMessage, download sob demanda,
// presença e agenda. Tudo opcional: sem `mediaCacheSize`/`trackContacts` o BaileysTransport não guarda nada.
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BaileysTransport, toIncomingMessage, unwrapContent, type BaileysSocketLike, type BaileysTransportOptions } from './baileys'
import { FakeTransport } from './fake'
import { MediaNotFoundError, TransportNotConnectedError, type AuthenticationState, type IncomingMessage } from './types'

const imageRaw = (id: string) => ({
  key: { id, remoteJid: '5511988887777@s.whatsapp.net', fromMe: false },
  messageTimestamp: 1_700_000_000,
  message: {
    imageMessage: {
      mimetype: 'image/png',
      fileLength: { toNumber: () => 2048 },
      fileSha256: Buffer.from('abc').toString('base64'),
      caption: 'legenda',
      contextInfo: { stanzaId: 'WA-QUOTED', externalAdReply: { sourceId: 'ad-1', ctwaClid: 'clid', sourceUrl: 'https://fb.me/a', title: 'Promo', thumbnailUrl: 'https://img' } },
    },
  },
})

describe('toIncomingMessage (A2/A4)', () => {
  it('extrai mídia, mensagem citada e anúncio CTWA sem mudar os campos de antes', () => {
    const msg = toIncomingMessage(imageRaw('WA1'))!
    expect(msg).toEqual({
      id: 'WA1',
      from: '5511988887777@s.whatsapp.net',
      fromMe: false,
      timestamp: 1_700_000_000_000,
      type: 'imageMessage',
      text: 'legenda',
      media: { kind: 'image', mime: 'image/png', size: 2048, sha256: Buffer.from('abc').toString('hex') },
      quotedId: 'WA-QUOTED',
      ad: { sourceId: 'ad-1', ctwaClid: 'clid', sourceUrl: 'https://fb.me/a', title: 'Promo', mediaUrl: 'https://img' },
    })
  })

  it('texto simples continua igual (sem campos novos); mídia dentro de invólucro é achada', () => {
    expect(toIncomingMessage({ key: { id: 'a', remoteJid: 'x@s.whatsapp.net' }, message: { conversation: 'oi' }, messageTimestamp: 1 })).toEqual({
      id: 'a',
      from: 'x@s.whatsapp.net',
      fromMe: false,
      timestamp: 1000,
      type: 'conversation',
      text: 'oi',
    })
    const wrapped = toIncomingMessage({
      key: { id: 'b', remoteJid: 'x@s.whatsapp.net' },
      message: { viewOnceMessageV2: { message: { videoMessage: { mimetype: 'video/mp4', fileName: 'v.mp4' } } } },
    })!
    expect(wrapped.type).toBe('viewOnceMessageV2')
    expect(wrapped.text).toBeUndefined()
    expect(wrapped.media).toEqual({ kind: 'video', mime: 'video/mp4', size: null, sha256: null, fileName: 'v.mp4' })
    expect(unwrapContent({ ephemeralMessage: { message: { conversation: 'x' } } })).toEqual({ conversation: 'x' })
  })
})

function connect(extra: Partial<BaileysTransportOptions> = {}) {
  const ev = new EventEmitter()
  const sock = {
    ev,
    sendMessage: vi.fn(async () => ({ key: { id: 'X' } })),
    sendPresenceUpdate: vi.fn(async () => undefined),
    groupFetchAllParticipating: vi.fn(async () => ({})),
    requestPairingCode: vi.fn(async () => 'P'),
    logout: vi.fn(async () => undefined),
    end: vi.fn(),
  } satisfies BaileysSocketLike
  const downloadMedia = vi.fn(async () => Buffer.from('bytes'))
  const transport = new BaileysTransport({ makeSocket: () => sock, downloadMedia, ...extra })
  return { ev, sock, transport, downloadMedia }
}

const auth = { creds: { registered: true }, keys: {} } as unknown as AuthenticationState
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('BaileysTransport (A2/A3/A7)', () => {
  it('sem as opções da integração: não guarda mídia nem agenda', async () => {
    const { ev, transport, downloadMedia } = connect()
    await transport.connect({ sessionId: 's', auth })
    ev.emit('connection.update', { connection: 'open' })
    ev.emit('messages.upsert', { type: 'notify', messages: [imageRaw('WA1')] })
    ev.emit('contacts.upsert', [{ id: '5511@s.whatsapp.net', name: 'X' }])
    await tick()
    await expect(transport.downloadMedia('WA1')).rejects.toBeInstanceOf(MediaNotFoundError)
    expect(downloadMedia).not.toHaveBeenCalled()
    expect(await transport.listContacts()).toEqual([])
  })

  it('mediaCacheSize: baixa a mídia de mensagens recentes pelo id (as mais antigas saem do cache)', async () => {
    const { ev, transport, downloadMedia } = connect({ mediaCacheSize: 2 })
    await transport.connect({ sessionId: 's', auth })
    ev.emit('connection.update', { connection: 'open' })
    const got: IncomingMessage[] = []
    transport.on('message', (m) => got.push(m))
    ev.emit('messages.upsert', { type: 'notify', messages: [imageRaw('A'), imageRaw('B'), imageRaw('C')] })
    await tick()
    expect(got.map((m) => m.id)).toEqual(['A', 'B', 'C'])
    expect(await transport.downloadMedia('C')).toEqual({ data: Buffer.from('bytes'), mime: 'image/png' })
    expect(downloadMedia).toHaveBeenCalledWith(expect.objectContaining({ key: expect.objectContaining({ id: 'C' }) }), expect.anything())
    await expect(transport.downloadMedia('A')).rejects.toBeInstanceOf(MediaNotFoundError)
  })

  it('sendPresence repassa composing/recording/paused; agenda via contacts.upsert/update e histórico', async () => {
    const { ev, sock, transport } = connect({ trackContacts: true })
    await expect(transport.sendPresence('x@s.whatsapp.net', 'recording')).rejects.toBeInstanceOf(TransportNotConnectedError)
    await transport.connect({ sessionId: 's', auth })
    ev.emit('connection.update', { connection: 'open' })
    await transport.sendPresence('x@s.whatsapp.net', 'recording')
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('recording', 'x@s.whatsapp.net')
    ev.emit('contacts.upsert', [{ id: '5511988887777@s.whatsapp.net', name: 'Ana' }, { id: 'g@g.us', name: 'grupo' }])
    ev.emit('contacts.update', [{ id: '5511988887777@s.whatsapp.net', notify: 'Aninha', lid: '99@lid' }])
    ev.emit('messaging-history.set', { chats: [], contacts: [{ id: '77@lid', phoneNumber: '5511977776666@s.whatsapp.net', notify: 'Bia' }] })
    await tick()
    expect(await transport.listContacts()).toEqual([
      { jid: '5511988887777@s.whatsapp.net', phone: '+5511988887777', lid: '99@lid', name: 'Ana', pushName: 'Aninha' },
      { jid: '77@lid', phone: '+5511977776666', lid: '77@lid', name: null, pushName: 'Bia' },
    ])
  })
})

describe('FakeTransport (A2/A3/A7)', () => {
  it('media, presences e contacts controlados pelo teste', async () => {
    const t = new FakeTransport()
    t.open()
    t.media.set('m1', new Uint8Array([1, 2, 3]))
    expect((await t.downloadMedia('m1')).data).toEqual(Buffer.from([1, 2, 3]))
    await expect(t.downloadMedia('m2')).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' })
    await t.sendPresence('x@s.whatsapp.net', 'paused')
    expect(t.presences).toEqual([{ to: 'x@s.whatsapp.net', kind: 'paused' }])
    t.contacts = [{ jid: 'a@s.whatsapp.net', phone: null, lid: null, name: null, pushName: null }]
    expect(await t.listContacts()).toHaveLength(1)
    await t.close('transient')
    await expect(t.listContacts()).rejects.toBeInstanceOf(TransportNotConnectedError)
  })
})
