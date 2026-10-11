// Filtro das figurinhas coletadas: as recebidas pelos chips (inclusive de grupos) podem ser sexuais ou sugestivas,
// e seriam reenviadas nas conversas. Antes de guardar, o modelo pequeno olha a imagem (até 4 quadros das animadas).
// Fecha em caso de dúvida: só 'ok' libera. 'unknown' (IA desligada, erro de rede) não libera nem apaga: revisa depois.
import Anthropic from '@anthropic-ai/sdk'
import type { ResolvedAiSettings } from '../ai/settings'

export const STICKER_MAX_FRAMES = 4

export type StickerVerdict = 'ok' | 'blocked' | 'unknown'

export interface StickerModerator {
  /** 'ok' = pode ser usada; 'blocked' = imprópria; 'unknown' = não deu para avaliar agora. Nunca lança. */
  review(webp: Buffer): Promise<StickerVerdict>
}

/** Quadros em PNG (até `max`, espalhados pela animação). Figurinha estática → 1 quadro. */
export async function stickerFrames(webp: Buffer, max = STICKER_MAX_FRAMES): Promise<Buffer[]> {
  const sharp = (await import('sharp')).default
  const pages = (await sharp(webp, { animated: true }).metadata()).pages ?? 1
  const picks = [...new Set(Array.from({ length: Math.min(max, pages) }, (_, i) => Math.floor((i * pages) / Math.min(max, pages))))]
  return Promise.all(picks.map((page) => sharp(webp, { page }).resize(256, 256, { fit: 'inside' }).png().toBuffer()))
}

const SYSTEM =
  'Você revisa figurinhas (stickers) de WhatsApp antes de um sistema reenviá-las em conversas comuns entre adultos ' +
  'desconhecidos. As imagens são quadros da mesma figurinha. Responda BLOQUEAR se qualquer quadro tiver nudez, ' +
  'conteúdo sexual ou sugestivo (poses ou roupas sensuais, foco em partes íntimas, insinuação ou piada sexual), ' +
  'violência explícita ou sangue, drogas, ou símbolos de ódio. Na dúvida, BLOQUEAR. Caso contrário responda OK. ' +
  'Responda só com OK ou BLOQUEAR.'

export class SmallStickerModerator implements StickerModerator {
  constructor(
    private readonly settings: () => Promise<ResolvedAiSettings>,
    private readonly clientFactory = (apiKey: string) => new Anthropic({ apiKey, maxRetries: 1 }),
    private readonly frames: (webp: Buffer) => Promise<Buffer[]> = stickerFrames,
  ) {}

  async review(webp: Buffer): Promise<StickerVerdict> {
    try {
      const settings = await this.settings()
      if (!settings.enabled || !settings.config.apiKey) return 'unknown'
      // Arquivo que nem abre como imagem não é figurinha utilizável.
      const images = await this.frames(webp).catch(() => [])
      if (!images.length) return 'blocked'
      const response = await this.clientFactory(settings.config.apiKey).messages.create({
        model: settings.config.smallModel,
        max_tokens: 16,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            ...images.map((png) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png.toString('base64') } })),
            { type: 'text', text: 'Esta figurinha pode ser usada?' },
          ],
        }],
      }, { signal: AbortSignal.timeout(Math.min(30_000, settings.config.timeoutMs)) })
      // Recusa do modelo de segurança: trata como imprópria.
      if (response.stop_reason === 'refusal') return 'blocked'
      if (response.stop_reason !== 'end_turn') return 'unknown'
      const answer = response.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim().toUpperCase().replace(/[^A-Z]/g, '')
      return answer === 'OK' ? 'ok' : answer === 'BLOQUEAR' ? 'blocked' : 'unknown'
    } catch {
      return 'unknown'
    }
  }
}
