import { describe, expect, it } from 'vitest'
import { mediaExtension, mediaZipPath, renderBranchConversation, renderFlowPlaybook, renderFlowSummary, type SpyFlow } from './flow'

const flow = (): SpyFlow => ({
  offerId: 'o1', phone: '557991063916', pageName: 'Receitas Que Nutrem', status: 'completa',
  generatedAt: new Date('2026-10-20T00:00:00.000Z'),
  branches: [
    {
      probeId: 'p1', branch: 'principal', status: 'concluida', endedReason: 'checkout capturado',
      summary: { etapa: 'checkout', preco: 'R$ 47', checkout: ['https://pay.x/abc'], opcoes: ['1) Sim'], links: ['https://pay.x/abc'] },
      turns: [
        { de: 'eu', texto: 'oi, vi o anúncio', at: new Date('2026-10-20T00:00:01.000Z') },
        { de: 'oferta', texto: '[áudio] é só pagar 47 no pix', at: new Date('2026-10-20T00:00:02.000Z') },
      ],
    },
  ],
  media: [{ id: 'm1', probeId: 'p1', branch: 'principal', kind: 'image', mime: 'image/jpeg', fileName: 'card.jpg', size: 9 }],
})

describe('flow render', () => {
  it('resumo traz preço, checkout e contagem de mensagens por ramificação', () => {
    const md = renderFlowSummary(flow())
    expect(md).toContain('# Receitas Que Nutrem — wa.me/557991063916')
    expect(md).toContain('Preço: R$ 47')
    expect(md).toContain('Checkout: https://pay.x/abc')
    expect(md).toContain('Mensagens: 1 da oferta, 1 da sonda')
  })

  it('conversa embute a transcrição no texto', () => {
    const f = flow()
    const md = renderBranchConversation(f, f.branches[0]!)
    expect(md).toContain('**OFERTA**')
    expect(md).toContain('[áudio] é só pagar 47 no pix')
  })

  it('roteiro lista empresa/lead e condições', () => {
    const txt = renderFlowPlaybook(flow())
    expect(txt).toContain('Preço: R$ 47')
    expect(txt).toContain('Empresa: [áudio] é só pagar 47 no pix')
    expect(txt).toContain('Lead: oi, vi o anúncio')
  })

  it('caminho e extensão da mídia no ZIP', () => {
    expect(mediaExtension('image/png')).toBe('.png')
    expect(mediaExtension('application/pdf')).toBe('.pdf')
    expect(mediaExtension('audio/ogg; codecs=opus')).toBe('.ogg')
    expect(mediaExtension('video/mp4')).toBe('.mp4')
    expect(mediaExtension('video/webm')).toBe('.webm')
    expect(mediaZipPath({ id: 'm1', probeId: 'p1', branch: 'principal', kind: 'image', mime: 'image/jpeg', fileName: 'card.jpg', size: 9 }, 1)).toBe('midias/principal/01-card.jpg')
    expect(mediaZipPath({ id: 'm2', probeId: null, branch: null, kind: 'document', mime: 'application/pdf', fileName: null, size: 9 }, 2)).toBe('midias/oferta/02-document.pdf')
  })
})
