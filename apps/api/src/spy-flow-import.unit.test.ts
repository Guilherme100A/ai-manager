import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { parseSpyFlowZip } from './spy-flow-import'

describe('parseSpyFlowZip', () => {
  it('importa identidade, conversa e mídias do pacote do Espião', async () => {
    const zip = new JSZip()
    zip.file('roteiro.txt', 'Funil de Sabão Lucrativo (wa.me/553497121711)\n\nConversa completa')
    zip.file('resumo.md', '# Sabão Lucrativo — wa.me/553497121711')
    zip.file('conversa-principal.md', '**OFERTA** · agora\nPDF enviado')
    zip.file('midias/principal/01-apostila.pdf', Buffer.from('%PDF-1.4'))
    zip.file('midias/principal/02-explicacao.ogg', Buffer.from('OggS'))
    const parsed = await parseSpyFlowZip((await zip.generateAsync({ type: 'uint8array' })).buffer as ArrayBuffer)
    expect(parsed).toMatchObject({ title: 'Sabão Lucrativo', phone: '553497121711' })
    expect(parsed.conversations).toEqual([{ fileName: 'conversa-principal.md', content: '**OFERTA** · agora\nPDF enviado' }])
    expect(parsed.media.map((m) => ({ branch: m.branch, kind: m.kind, mime: m.mime, fileName: m.fileName }))).toEqual([
      { branch: 'principal', kind: 'document', mime: 'application/pdf', fileName: 'apostila.pdf' },
      { branch: 'principal', kind: 'audio', mime: 'audio/ogg', fileName: 'explicacao.ogg' },
    ])
  })

  it('recusa pacote sem roteiro', async () => {
    const zip = new JSZip()
    zip.file('resumo.md', '# incompleto')
    await expect(parseSpyFlowZip((await zip.generateAsync({ type: 'uint8array' })).buffer as ArrayBuffer)).rejects.toThrow('roteiro.txt')
  })
})
