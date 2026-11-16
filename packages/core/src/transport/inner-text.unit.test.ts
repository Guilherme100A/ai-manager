import { describe, expect, it } from 'vitest'
import { innerText, toIncomingMessage } from './baileys'

const raw = (message: Record<string, unknown>) => ({ key: { id: 'M1', remoteJid: '5511999998888@s.whatsapp.net', fromMe: false }, message, messageTimestamp: 1790000000 })

describe('texto de mensagens interativas e com invólucro', () => {
  it('temporária: o texto dentro do ephemeralMessage deixa de se perder', () => {
    const msg = toIncomingMessage(raw({ ephemeralMessage: { message: { extendedTextMessage: { text: 'Oi! Qual seu nome?' } } } }))
    expect(msg?.text).toBe('Oi! Qual seu nome?')
  })

  it('botões, lista e modelo: texto + opções numeradas + links', () => {
    expect(innerText('buttonsMessage', { contentText: 'Quer o plano?', buttons: [{ buttonText: { displayText: 'Sim' } }, { buttonText: { displayText: 'Mais info' } }] }))
      .toBe('Quer o plano?\n[opções: 1) Sim | 2) Mais info]')
    expect(innerText('listMessage', { description: 'Escolha', sections: [{ rows: [{ title: 'Básico' }, { title: 'VIP' }] }] }))
      .toBe('Escolha\n[opções: 1) Básico | 2) VIP]')
    expect(innerText('templateMessage', { hydratedTemplate: { hydratedContentText: 'Garanta já', hydratedButtons: [{ urlButton: { displayText: 'Comprar', url: 'https://pay.exemplo.com/x' } }] } }))
      .toBe('Garanta já\n[opções: 1) Comprar]\n[link: https://pay.exemplo.com/x]')
    expect(innerText('interactiveMessage', { body: { text: 'Pagamento' }, nativeFlowMessage: { buttons: [{ buttonParamsJson: '{"display_text":"Pagar","url":"https://checkout.x/1"}' }, { buttonParamsJson: 'quebrado' }] } }))
      .toBe('Pagamento\n[opções: 1) Pagar]\n[link: https://checkout.x/1]')
  })

  it('respostas a botão/lista e o que já funcionava continuam iguais', () => {
    expect(innerText('buttonsResponseMessage', { selectedDisplayText: 'Sim' })).toBe('Sim')
    expect(innerText('listResponseMessage', { title: 'VIP' })).toBe('VIP')
    expect(toIncomingMessage(raw({ conversation: 'oi' }))?.text).toBe('oi')
    expect(toIncomingMessage(raw({ imageMessage: { caption: 'foto' } }))?.text).toBe('foto')
    expect(toIncomingMessage(raw({ imageMessage: {} }))?.text).toBeUndefined()
    expect(innerText('buttonsMessage', {})).toBeUndefined()
  })
})
