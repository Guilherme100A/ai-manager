// Filtro local das figurinhas coletadas (sem API externa): o NSFWJS (TensorFlow.js, backend WebAssembly) dá a
// probabilidade de conteúdo sexual de até 4 quadros da figurinha. O modelo só é carregado quando há figurinhas para
// avaliar e é liberado depois (release), para não ocupar memória (~300 MB) o tempo todo.
// Nos testes com as figurinhas reais ele erra para os dois lados (close de rosto/pele vira "Porn"), por isso o
// filtro por nome de grupo vem antes e o limite é baixo: perder uma figurinha boa não faz falta, mandar uma +18 faz.

export const STICKER_MAX_FRAMES = 4
/** Classes do NSFWJS tratadas como impróprias. */
export const NSFW_CLASSES = ['Porn', 'Hentai', 'Sexy'] as const

export interface StickerScorer {
  /** Carrega o modelo (lança se não der: quem chama mantém as figurinhas para a próxima vez). */
  ready(): Promise<void>
  /** Maior probabilidade de conteúdo impróprio entre os quadros (0 a 1). Lança se o arquivo não for imagem. */
  score(webp: Buffer): Promise<number>
  /** Libera o modelo da memória (carrega de novo na próxima chamada a `score`). */
  release(): Promise<void>
}

/** Quadros RGB 224x224 (até `max`, espalhados pela animação). Figurinha estática → 1 quadro. */
export async function stickerFrames(webp: Buffer, max = STICKER_MAX_FRAMES): Promise<Array<{ data: Uint8Array; width: number; height: number }>> {
  const sharp = (await import('sharp')).default
  const pages = (await sharp(webp, { animated: true }).metadata()).pages ?? 1
  const count = Math.min(max, pages)
  const picks = [...new Set(Array.from({ length: count }, (_, i) => Math.floor((i * pages) / count)))]
  return Promise.all(picks.map(async (page) => {
    const { data, info } = await sharp(webp, { page }).flatten({ background: '#ffffff' }).resize(224, 224, { fit: 'fill' })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true })
    return { data: new Uint8Array(data), width: info.width, height: info.height }
  }))
}

interface NsfwModel { classify(img: unknown): Promise<Array<{ className: string; probability: number }>>; model?: { dispose?(): void } }

/** NSFWJS (MobileNetV2) com TensorFlow.js em WebAssembly: roda no Alpine sem dependência nativa. */
export function nsfwjsScorer(): StickerScorer {
  let loading: Promise<{ tf: typeof import('@tensorflow/tfjs'); model: NsfwModel }> | undefined
  const load = () => (loading ??= (async () => {
    const tf = await import('@tensorflow/tfjs')
    await import('@tensorflow/tfjs-backend-wasm')
    await tf.setBackend('wasm')
    await tf.ready()
    const nsfwjs = await import('nsfwjs')
    const model = (await nsfwjs.load('MobileNetV2')) as unknown as NsfwModel
    return { tf, model }
  })().catch((err: unknown) => { loading = undefined; throw err }))

  return {
    async ready() {
      await load()
    },
    async score(webp) {
      const frames = await stickerFrames(webp)
      const { tf, model } = await load()
      let worst = 0
      for (const f of frames) {
        const img = tf.tensor3d(f.data, [f.height, f.width, 3], 'int32')
        try {
          for (const p of await model.classify(img)) {
            if ((NSFW_CLASSES as readonly string[]).includes(p.className)) worst = Math.max(worst, p.probability)
          }
        } finally {
          img.dispose()
        }
      }
      return worst
    },
    async release() {
      const current = loading
      loading = undefined
      if (!current) return
      const { tf, model } = await current.catch(() => ({ tf: undefined, model: undefined }))
      model?.model?.dispose?.()
      tf?.disposeVariables()
    },
  }
}
