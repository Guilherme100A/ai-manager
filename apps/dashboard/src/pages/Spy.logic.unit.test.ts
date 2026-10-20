import { describe, expect, it } from 'vitest'
import type { SpyAd } from '../lib/types'
import { adLibraryUrl, formatPhone, parseLinks, rowTitle, summarize } from './Spy.logic'

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
