// Processa a fila do Espião, uma linha por vez (o ritmo lento é proposital: Facebook e buscador sem login).
import { classifyInput, profileToken, type LibraryAd } from './parse'
import type { SpyFinder } from './finder'
import type { SpyAdRow, SpyStore } from './store'


export interface SpyRunnerLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

export interface SpyRunnerOptions {
  store: SpyStore
  finder: SpyFinder
  logger?: SpyRunnerLogger
  /** Espera quando a fila está vazia (ms). */
  idleMs?: number
}

export class SpyRunner {
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private running: Promise<void> | undefined

  constructor(private readonly options: SpyRunnerOptions) {}

  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.options.store.requeueStale().catch(() => undefined)
    this.schedule(0)
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.running
  }

  /** Processa a próxima linha; devolve false com a fila vazia. */
  async tick(): Promise<boolean> {
    const row = await this.options.store.claimNext()
    if (!row) return false
    try {
      await this.process(row)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.options.logger?.warn({ id: row.id, err: message }, 'spy: falha ao processar link')
      await this.options.store.failed(row.id, message)
    }
    return true
  }

  private async process(row: SpyAdRow) {
    const { store, finder } = this.options
    const input = classifyInput(row.inputUrl)
    if (input.kind === 'invalid') return store.failed(row.id, input.reason)
    if (input.kind === 'whatsapp') return void (await store.found(row.id, { phone: input.phone, foundVia: 'link', evidenceUrl: row.inputUrl }))
    if (input.kind === 'search') return void (await store.expand(row, await finder.searchAds(input.url)))

    let result
    if (input.kind === 'post') {
      result = await finder.findForPost(input.url)
    } else {
      // Linha criada a partir de uma busca já vem com o anúncio lido.
      const ad = row.data.profileUri !== undefined && row.adArchiveId === input.adArchiveId ? rowToAd(row) : await finder.loadAd(input.adArchiveId)
      if (ad !== undefined && row.data.profileUri === undefined) await store.saveAd(row.id, ad)
      result = await finder.findForAd(ad)
    }
    if (result.phone && result.foundVia) {
      await store.found(row.id, { phone: result.phone, foundVia: result.foundVia, evidenceUrl: result.evidenceUrl, candidates: result.candidates })
      this.options.logger?.info({ id: row.id, via: result.foundVia }, 'spy: número achado')
    } else {
      await store.notFound(row.id, result.reason ?? 'número não encontrado', result.candidates)
    }
  }

  private schedule(ms: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .catch((err) => { this.options.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'spy: erro na fila'); return false })
        .then((worked) => this.schedule(worked ? 0 : this.options.idleMs ?? 5_000))
    }, ms)
  }
}

function rowToAd(row: SpyAdRow): LibraryAd {
  const d = row.data
  const token = d.profileUri ? profileToken(d.profileUri) : undefined
  return {
    adArchiveId: row.adArchiveId!, pageId: row.pageId ?? undefined, pageName: row.pageName ?? undefined, profileUri: d.profileUri, profileToken: token,
    ctaType: d.ctaType, linkUrl: d.linkUrl, title: d.title, body: d.body, displayFormat: d.displayFormat, startDate: d.startDate,
    images: d.images ?? [], videos: d.videos ?? [],
  }
}

