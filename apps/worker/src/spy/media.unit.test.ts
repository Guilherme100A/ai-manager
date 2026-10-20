import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ProbeMediaReader } from '@wsm/core'
import { SpyMediaCapture } from './media'

function msg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return { id: 'wamid.1', from: '5584920022034@s.whatsapp.net', fromMe: false, timestamp: Date.now(), type: 'audioMessage', ...over }
}

function setup(opts: { listening?: boolean; transcript?: string; docText?: string; imageText?: string; download?: () => Promise<{ data: Buffer; mime: string }> } = {}) {
  const store = {
    listening: vi.fn(async () => (opts.listening ?? true ? ({ id: 'p1', offerId: 'o1', branch: 'principal' } as never) : undefined)),
    attachMedia: vi.fn(async () => undefined),
    saveMediaFile: vi.fn(async () => undefined),
  }
  const reader: ProbeMediaReader = {
    transcribeAudio: vi.fn(async () => opts.transcript),
    readPdf: vi.fn(async () => opts.docText),
    readImage: vi.fn(async () => opts.imageText),
  }
  const downloadMedia = vi.fn(opts.download ?? (async () => ({ data: Buffer.from('bytes'), mime: 'audio/ogg' })))
  const logger = { info: vi.fn(), warn: vi.fn() }
  const capture = new SpyMediaCapture({ store: store as never, reader, getTransport: () => ({ downloadMedia }), logger })
  return { capture, store, reader, downloadMedia, logger }
}

const ev = (m: IncomingMessage) => ({ sessionId: 's1', inboundId: 'm1', phone: '+5584920022034', msg: m })

describe('SpyMediaCapture', () => {
  it('transcreve o áudio, grava a transcrição e também o arquivo para o pacote', async () => {
    const { capture, store, downloadMedia } = setup({ transcript: 'paga 97 no link' })
    await capture.capture(ev(msg({ media: { kind: 'audio', mime: 'audio/ogg; codecs=opus', size: 10, sha256: null } })))
    expect(downloadMedia).toHaveBeenCalledWith('wamid.1')
    expect(store.attachMedia).toHaveBeenCalledWith('m1', { transcript: 'paga 97 no link' })
    expect(store.saveMediaFile).toHaveBeenCalledWith(expect.objectContaining({ offerId: 'o1', probeId: 'p1', kind: 'audio' }))
  })

  it('lê o PDF, guarda o texto e também o arquivo para o pacote', async () => {
    const { capture, store, downloadMedia } = setup({ docText: 'Plano Premium R$ 497' })
    downloadMedia.mockResolvedValue({ data: Buffer.from('%PDF-1.4'), mime: 'application/pdf' })
    await capture.capture(ev(msg({ type: 'documentMessage', media: { kind: 'document', mime: 'application/pdf', fileName: 'oferta.pdf', size: 20, sha256: null } })))
    expect(store.attachMedia).toHaveBeenCalledWith('m1', { docText: 'Plano Premium R$ 497', fileName: 'oferta.pdf' })
    expect(store.saveMediaFile).toHaveBeenCalledWith(expect.objectContaining({ offerId: 'o1', probeId: 'p1', messageId: 'm1', branch: 'principal', kind: 'document', mime: 'application/pdf', fileName: 'oferta.pdf' }))
  })

  it('transcreve o vídeo (VSL) pelo Whisper', async () => {
    const { capture, store, reader, downloadMedia } = setup({ transcript: 'nesse vídeo eu te mostro o método' })
    downloadMedia.mockResolvedValue({ data: Buffer.from('mp4'), mime: 'video/mp4' })
    await capture.capture(ev(msg({ type: 'videoMessage', media: { kind: 'video', mime: 'video/mp4', size: 1000, sha256: null } })))
    expect(reader.transcribeAudio).toHaveBeenCalled()
    expect(store.attachMedia).toHaveBeenCalledWith('m1', { transcript: 'nesse vídeo eu te mostro o método' })
    expect(store.saveMediaFile).toHaveBeenCalledWith(expect.objectContaining({ offerId: 'o1', kind: 'video', mime: 'video/mp4' }))
  })

  it('lê a imagem (card de oferta) pela visão', async () => {
    const { capture, store, reader, downloadMedia } = setup({ imageText: 'OFERTA R$ 47 no pix' })
    downloadMedia.mockResolvedValue({ data: Buffer.from('jpg'), mime: 'image/jpeg' })
    await capture.capture(ev(msg({ type: 'imageMessage', media: { kind: 'image', mime: 'image/jpeg', size: 1000, sha256: null } })))
    expect(reader.readImage).toHaveBeenCalled()
    expect(store.attachMedia).toHaveBeenCalledWith('m1', { imageText: 'OFERTA R$ 47 no pix' })
    expect(store.saveMediaFile).toHaveBeenCalledWith(expect.objectContaining({ offerId: 'o1', kind: 'image', mime: 'image/jpeg' }))
  })

  it('ignora número que nenhuma sonda escuta', async () => {
    const { capture, store, downloadMedia } = setup({ listening: false, transcript: 'x' })
    await capture.capture(ev(msg({ media: { kind: 'audio', mime: 'audio/ogg', size: 1, sha256: null } })))
    expect(downloadMedia).not.toHaveBeenCalled()
    expect(store.attachMedia).not.toHaveBeenCalled()
  })

  it('ignora documento que não é PDF e figurinha', async () => {
    const { capture, store, reader } = setup({})
    await capture.capture(ev(msg({ type: 'documentMessage', media: { kind: 'document', mime: 'application/zip', fileName: 'x.zip', size: 1, sha256: null } })))
    await capture.capture(ev(msg({ type: 'stickerMessage', media: { kind: 'sticker', mime: 'image/webp', size: 1, sha256: null } })))
    expect(reader.readPdf).not.toHaveBeenCalled()
    expect(reader.readImage).not.toHaveBeenCalled()
    expect(reader.transcribeAudio).not.toHaveBeenCalled()
    expect(store.attachMedia).not.toHaveBeenCalled()
  })

  it('download que falha não lança e não grava nada', async () => {
    const { capture, store, logger } = setup({ download: async () => { throw new Error('expirou') }, transcript: 'x' })
    await expect(capture.capture(ev(msg({ media: { kind: 'audio', mime: 'audio/ogg', size: 1, sha256: null } })))).resolves.toBeUndefined()
    expect(store.attachMedia).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('transcrição vazia não anexa texto, mas ainda guarda o arquivo pro pacote', async () => {
    const { capture, store } = setup({ transcript: undefined })
    await capture.capture(ev(msg({ media: { kind: 'audio', mime: 'audio/ogg', size: 1, sha256: null } })))
    expect(store.attachMedia).not.toHaveBeenCalled()
    expect(store.saveMediaFile).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio' }))
  })
})
