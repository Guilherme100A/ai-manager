// Captura de mídia das sondas do Espião: quando a oferta manda áudio ou PDF para um número que uma sonda escuta,
// baixa os bytes (do cache do transporte, por isso roda no instante em que a mensagem chega) e guarda o conteúdo
// lido na própria mensagem (transcript do áudio / texto do PDF). Assim a IA da sonda mapeia o funil por completo.
import { isPdf, type IncomingMessage, type ProbeMediaReader, type SpyProbeStore } from '@wsm/core'

/** Transporte vivo da sessão: só precisamos baixar a mídia (A2). */
interface MediaTransport {
  downloadMedia?(messageId: string): Promise<{ data: Buffer; mime: string }>
}

export interface SpyMediaCaptureOptions {
  store: Pick<SpyProbeStore, 'listening' | 'attachMedia' | 'saveMediaFile'>
  reader: ProbeMediaReader
  getTransport: (sessionId: string) => MediaTransport | undefined
  logger: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }
}

/** Corta um texto longo (PDF grande) para não estourar o contexto da IA e o banco. */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Teto do arquivo guardado no banco para o ZIP (vídeo pode ser grande): acima disso, só a transcrição. */
const MAX_STORED_BYTES = 32 * 1024 * 1024

export class SpyMediaCapture {
  constructor(private readonly opts: SpyMediaCaptureOptions) {}

  /** Chamado para toda mensagem recebida com mídia (gancho `enrichMedia` da IA assistiva). Nunca lança. */
  async capture(e: { sessionId: string; inboundId: string; phone: string; msg: IncomingMessage }): Promise<void> {
    const media = e.msg.media
    const kind = media?.kind
    // Áudio e vídeo são transcritos; PDF e imagem são lidos. Documento só se for PDF; figurinha é ignorada.
    if (kind !== 'audio' && kind !== 'video' && kind !== 'image' && kind !== 'document') return
    if (kind === 'document' && !isPdf(media)) return
    // Só mídia de número que uma sonda escuta (ativa ou na janela de remarketing): não lê o CRM inteiro.
    const probe = await this.opts.store.listening(e.sessionId, e.phone)
    if (!probe) return
    const transport = this.opts.getTransport(e.sessionId)
    if (!transport?.downloadMedia) return

    let bytes: { data: Buffer; mime: string }
    try {
      bytes = await transport.downloadMedia(e.msg.id)
    } catch (err) {
      // Mídia já saiu do cache ou falhou o download: segue com o rótulo "[áudio]"/"[vídeo]"/"[imagem]"/"[documento]".
      return this.opts.logger.warn({ session_id: e.sessionId, message_id: e.inboundId, err: (err as Error).message }, 'spy-media: download falhou')
    }

    // Áudio, vídeo, imagem e PDF entram no pacote do fluxo (ZIP): guarda o arquivo mesmo se a leitura falhar depois.
    if (bytes.data.byteLength > 0 && bytes.data.byteLength <= MAX_STORED_BYTES) {
      try {
        await this.opts.store.saveMediaFile({
          offerId: probe.offerId, probeId: probe.id, messageId: e.inboundId, branch: probe.branch,
          kind, mime: bytes.mime, bytes: bytes.data, ...(media?.fileName ? { fileName: media.fileName } : {}),
        })
      } catch (err) {
        this.opts.logger.warn({ session_id: e.sessionId, message_id: e.inboundId, err: (err as Error).message }, 'spy-media: arquivo não guardado')
      }
    }

    try {
      const patch = await this.read(kind, bytes, media)
      if (!patch) return
      await this.opts.store.attachMedia(e.inboundId, patch)
      this.opts.logger.info({ session_id: e.sessionId, message_id: e.inboundId, kind }, 'spy-media: conteúdo lido')
    } catch (err) {
      this.opts.logger.warn({ session_id: e.sessionId, message_id: e.inboundId, kind, err: (err as Error).message }, 'spy-media: leitura falhou')
    }
  }

  /** Lê a mídia pelo tipo e devolve o que gravar na mensagem; `undefined` se não saiu conteúdo. */
  private async read(
    kind: 'audio' | 'video' | 'image' | 'document',
    bytes: { data: Buffer; mime: string },
    media: IncomingMessage['media'],
  ): Promise<Record<string, string> | undefined> {
    if (kind === 'audio' || kind === 'video') {
      const transcript = await this.opts.reader.transcribeAudio(bytes.data, bytes.mime)
      return transcript ? { transcript: cap(transcript, 4_000) } : undefined
    }
    if (kind === 'image') {
      const imageText = await this.opts.reader.readImage(bytes.data, bytes.mime)
      return imageText ? { imageText: cap(imageText, 4_000) } : undefined
    }
    const docText = await this.opts.reader.readPdf(bytes.data, media?.fileName)
    return docText ? { docText: cap(docText, 8_000), ...(media?.fileName ? { fileName: media.fileName } : {}) } : undefined
  }
}
