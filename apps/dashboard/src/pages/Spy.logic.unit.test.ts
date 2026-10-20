import { describe, expect, it } from 'vitest'
import type { SpyAd } from '../lib/types'
import { adLibraryUrl, canDownloadFlow, formatPhone, parseLinks, probeStatusLabel, rowTitle, summarize } from './Spy.logic'

describe('Spy.logic', () => {
  it('um link por linha, sem vazios nem repetidos', () => {
    expect(parseLinks('https://a\n\n https://b , https://a\nwa.me/1')).toEqual(['https://a', 'https://b', 'wa.me/1'])
  })

  it('formata número brasileiro e deixa os outros com +', () => {
    expect(formatPhone('5584920022034')).toBe('+55 84 92002-2034')
    expect(formatPhone('557991073072')).toBe('+55 79 9107-3072')
    expect(formatPhone('5215512345678')).toBe('+5215512345678')
  })

  it('link da Biblioteca pelo id do anúncio, senão o link colado', () => {
    expect(adLibraryUrl({ adArchiveId: '123', inputUrl: 'x' })).toBe('https://www.facebook.com/ads/library/?id=123')
    expect(adLibraryUrl({ adArchiveId: null, inputUrl: 'wa.me/1' })).toBe('wa.me/1')
  })

  it('resumo ignora a linha da busca expandida', () => {
    const ad = (status: SpyAd['status']) => ({ status }) as SpyAd
    expect(summarize([ad('expandido'), ad('na_fila'), ad('lendo'), ad('achado'), ad('sem_numero'), ad('erro')])).toEqual({ total: 5, pending: 2, found: 1, missing: 2 })
  })
})

describe('rowTitle', () => {
  it('mostra o tipo de link enquanto não há nome da página', () => {
    expect(rowTitle({ status: 'lendo', inputUrl: 'x', adArchiveId: '1' })).toBe('Lendo anúncio…')
    expect(rowTitle({ status: 'achado', inputUrl: 'https://wa.me/55', adArchiveId: null })).toBe('Link do WhatsApp')
    expect(rowTitle({ status: 'achado', inputUrl: 'https://www.facebook.com/p/videos/1/', adArchiveId: null })).toBe('Post da página')
  })
})

describe('probeStatusLabel', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  it('ativa (vai responder / esperando), concluída ouvindo remarketing e parada', () => {
    expect(probeStatusLabel({ status: 'ativa', replyDueAt: '2026-10-20T12:01:00Z', listenUntil: null }, now)).toBe('Vai responder…')
    expect(probeStatusLabel({ status: 'ativa', replyDueAt: null, listenUntil: null }, now)).toBe('Esperando a oferta')
    expect(probeStatusLabel({ status: 'concluida', replyDueAt: null, listenUntil: '2026-10-27T12:00:00Z' }, now)).toBe('Concluída · ouvindo remarketing')
    expect(probeStatusLabel({ status: 'parada', replyDueAt: null, listenUntil: null }, now)).toBe('Parada')
  })
})

describe('canDownloadFlow', () => {
  it('libera o ZIP quando a oferta está sondando ou completa', () => {
    expect(canDownloadFlow('sondando')).toBe(true)
    expect(canDownloadFlow('completa')).toBe(true)
    expect(canDownloadFlow('nova')).toBe(false)
  })
})
