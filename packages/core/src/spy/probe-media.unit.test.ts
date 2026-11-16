import { describe, expect, it, vi } from 'vitest'
import type { ResolvedAiSettings } from '../ai/settings'
import { isPdf, SpyMediaReader, transcribeFileName } from './probe-media'

const settings = (over: Partial<{ apiKey: string; provider: string; smallModel: string }> = {}) =>
  async () => ({
    provider: over.provider ?? 'anthropic',
    enabled: true,
    config: { apiKey: over.apiKey ?? 'sk-ant', smallModel: over.smallModel ?? 'claude-small', timeoutMs: 30_000 },
    sources: {},
    updatedAt: null,
  }) as unknown as ResolvedAiSettings

describe('transcribeFileName / isPdf', () => {
  it('escolhe a extensão pelo mime e reconhece PDF', () => {
    expect(transcribeFileName('audio/ogg; codecs=opus')).toBe('audio.ogg')
    expect(transcribeFileName('audio/mp4')).toBe('audio.m4a')
    expect(transcribeFileName('video/mp4')).toBe('media.mp4')
    expect(transcribeFileName('video/webm')).toBe('media.webm')
    expect(transcribeFileName('')).toBe('audio.ogg')
    expect(isPdf({ mime: 'application/pdf', fileName: undefined })).toBe(true)
    expect(isPdf({ mime: 'application/octet-stream', fileName: 'oferta.PDF' })).toBe(true)
    expect(isPdf({ mime: 'image/jpeg', fileName: 'x.jpg' })).toBe(false)
    expect(isPdf(undefined)).toBe(false)
  })
})

describe('SpyMediaReader.transcribeAudio', () => {
  it('manda o áudio para o Whisper e devolve o texto', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ text: ' o curso é 97 ' }), { status: 200 })))
    const reader = new SpyMediaReader(settings(), { apiKey: 'sk-oa', fetch: fetchMock })
    expect(await reader.transcribeAudio(Buffer.from('fake-audio'), 'audio/ogg; codecs=opus')).toBe('o curso é 97')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(init!.body).toBeInstanceOf(FormData)
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-oa')
  })

  it('sem chave OpenAI não transcreve', async () => {
    const reader = new SpyMediaReader(settings())
    expect(await reader.transcribeAudio(Buffer.from('x'), 'audio/ogg')).toBeUndefined()
  })

  it('erro HTTP da OpenAI é lançado (o chamador registra e segue)', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response('nope', { status: 401 })))
    const reader = new SpyMediaReader(settings(), { apiKey: 'sk-oa', fetch: fetchMock })
    await expect(reader.transcribeAudio(Buffer.from('x'), 'audio/ogg')).rejects.toThrow(/401/)
  })
})

describe('SpyMediaReader.readPdf', () => {
  it('manda o PDF como bloco de documento e devolve o texto lido', async () => {
    const create = vi.fn((_body: Record<string, unknown>) => Promise.resolve({ content: [{ type: 'text', text: 'Plano Premium — R$ 497\nlink: pay.x' }] }))
    const reader = new SpyMediaReader(settings(), undefined, () => ({ messages: { create } }) as never)
    expect(await reader.readPdf(Buffer.from('%PDF-1.4'), 'oferta.pdf')).toBe('Plano Premium — R$ 497\nlink: pay.x')
    const body = create.mock.calls[0]![0] as { messages: Array<{ content: Array<Record<string, unknown>> }> }
    const doc = body.messages[0]!.content[0] as { type: string; source: { type: string; media_type: string; data: string } }
    expect(doc.type).toBe('document')
    expect(doc.source.media_type).toBe('application/pdf')
    expect(doc.source.data).toBe(Buffer.from('%PDF-1.4').toString('base64'))
  })

  it('sem chave Anthropic (ou provider não-anthropic) não lê o PDF', async () => {
    const create = vi.fn()
    const reader = new SpyMediaReader(settings({ apiKey: '' }), undefined, () => ({ messages: { create } }) as never)
    expect(await reader.readPdf(Buffer.from('%PDF'), 'x.pdf')).toBeUndefined()
    const openaiOnly = new SpyMediaReader(settings({ provider: 'openai' }), undefined, () => ({ messages: { create } }) as never)
    expect(await openaiOnly.readPdf(Buffer.from('%PDF'), 'x.pdf')).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('SpyMediaReader.readImage', () => {
  it('manda a imagem como bloco de visão e devolve o texto lido', async () => {
    const create = vi.fn((_body: Record<string, unknown>) => Promise.resolve({ content: [{ type: 'text', text: 'OFERTA R$ 47 — pague no pix' }] }))
    const reader = new SpyMediaReader(settings(), undefined, () => ({ messages: { create } }) as never)
    expect(await reader.readImage(Buffer.from('jpeg-bytes'), 'image/jpeg')).toBe('OFERTA R$ 47 — pague no pix')
    const body = create.mock.calls[0]![0] as { messages: Array<{ content: Array<Record<string, unknown>> }> }
    const block = body.messages[0]!.content[0] as { type: string; source: { type: string; media_type: string; data: string } }
    expect(block.type).toBe('image')
    expect(block.source.media_type).toBe('image/jpeg')
    expect(block.source.data).toBe(Buffer.from('jpeg-bytes').toString('base64'))
  })

  it('mime de imagem não suportado não chama a IA', async () => {
    const create = vi.fn()
    const reader = new SpyMediaReader(settings(), undefined, () => ({ messages: { create } }) as never)
    expect(await reader.readImage(Buffer.from('x'), 'image/tiff')).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })
})
