import { createHash } from 'node:crypto'
import type { OutgoingContent, WaTransport } from '@wsm/core'
import { describe, expect, it, vi } from 'vitest'
import { attachPrivateCrmMedia, privateCrmMediaResolver } from './private-media'

const SESSION = '11111111-1111-4111-8111-111111111111'
const data = Buffer.from('private fixture bytes'), sha = createHash('sha256').update(data).digest('hex')
const url = 'blob:' + sha
const mimes: Record<string, string> = { image: 'image/png', audio: 'audio/mpeg', document: 'application/pdf', video: 'video/mp4', sticker: 'image/webp' }
const content = (kind: string) => ({ [kind]: { url }, caption: 'fixture', mimetype: mimes[kind], ...(kind === 'audio' ? { ptt: true } : {}), ...(kind === 'document' ? { fileName: 'fixture.pdf' } : {}) }) as OutgoingContent

describe('private CRM media at the transport boundary', () => {
  it.each(['image', 'audio', 'document', 'video', 'sticker'])('%s resolves authenticated private bytes without changing queued reference', async kind => {
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return body.metadata_only ? Response.json({ sha256: sha, size: data.length, mime: mimes[kind] }) : new Response(data, { headers: { 'content-type': mimes[kind]! } })
    })
    const resolve = privateCrmMediaResolver({ baseUrl: 'http://crm-api:3000', token: 'synthetic-internal', fetch: request as typeof fetch })
    const original = content(kind), send = vi.fn(async () => ({ messageId: 'WA-fixture' }))
    const t = { sendMessage: send } as unknown as WaTransport
    attachPrivateCrmMedia(t, SESSION, resolve)
    await resolve.preflight(SESSION, original)
    expect(await t.sendMessage('12025550123@s.whatsapp.net', original)).toEqual({ messageId: 'WA-fixture' })
    expect((send.mock.calls as unknown as [string, Record<string, unknown>][])[0]![1][kind]).toEqual(data)
    expect((send.mock.calls as unknown as [string, Record<string, unknown>][])[0]![1]).toMatchObject({ mimetype: mimes[kind], caption: 'fixture' })
    expect(original).toEqual(content(kind))
    expect(String(request.mock.calls[0]![0])).toBe('http://crm-api:3000/internal/wa-media')
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer synthetic-internal' } })
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toMatchObject({ session_id: SESSION, sha256: sha })
    expect(String(request.mock.calls[0]![0])).not.toContain('synthetic-internal')
  })

  it('text and external media keep existing delivery and never invoke private reader', async () => {
    const request = vi.fn(), resolve = privateCrmMediaResolver({ baseUrl: 'http://crm-api:3000', token: 'fixture', fetch: request })
    for (const input of [{ text: 'fixture' }, { image: { url: 'https://cdn.example.test/file.png' } }]) {
      await resolve.preflight(SESSION, input)
      expect(await resolve(SESSION, input)).toBe(input)
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('denied or missing asset fails preflight without exposing token or sending', async () => {
    const resolve = privateCrmMediaResolver({ baseUrl: 'http://crm-api:3000', token: 'sensitive-fixture', fetch: vi.fn(async () => new Response('', { status: 404 })) as typeof fetch })
    await expect(resolve.preflight(SESSION, content('image'))).rejects.toThrow('CRM_PRIVATE_MEDIA_UNAVAILABLE')
    const send = vi.fn(), t = { sendMessage: send } as unknown as WaTransport
    attachPrivateCrmMedia(t, SESSION, resolve)
    await expect(t.sendMessage('12025550123@s.whatsapp.net', content('image'))).rejects.not.toThrow('sensitive-fixture')
    expect(send).not.toHaveBeenCalled()
  })

  it('invalid references and session never turn into filesystem or arbitrary URL access', async () => {
    const request = vi.fn(), resolve = privateCrmMediaResolver({ baseUrl: 'http://crm-api:3000', token: 'fixture', fetch: request })
    await expect(resolve(SESSION, { image: { url: 'blob:../../secret' } })).rejects.toThrow('INVALID_REFERENCE')
    await expect(resolve('../session', content('image'))).rejects.toThrow('INVALID_REFERENCE')
    expect(request).not.toHaveBeenCalled()
    expect(() => privateCrmMediaResolver({ baseUrl: 'http://user:secret@crm-api:3000', token: 'fixture' })).toThrow('Invalid private CRM origin')
  })

  it('corrupt or oversized response never reaches the socket', async () => {
    for (const response of [new Response('wrong bytes'), new Response('x', { headers: { 'content-length': String(31 * 1024 * 1024) } })]) {
      const resolve = privateCrmMediaResolver({ baseUrl: 'http://crm-api:3000', token: 'fixture', fetch: vi.fn(async () => response) as typeof fetch })
      const send = vi.fn(), t = { sendMessage: send } as unknown as WaTransport
      attachPrivateCrmMedia(t, SESSION, resolve)
      await expect(t.sendMessage('12025550123@s.whatsapp.net', content('document'))).rejects.toThrow('CRM_PRIVATE_MEDIA_')
      expect(send).not.toHaveBeenCalled()
    }
  })

  it('failed fetch/redirect and mismatched metadata fail closed', async () => {
    const resolve = privateCrmMediaResolver({ baseUrl: 'https://crm.example.test', token: 'fixture', fetch: vi.fn(async () => { throw Error('redirect or unavailable') }) as typeof fetch })
    await expect(resolve(SESSION, content('image'))).rejects.toThrow('CRM_PRIVATE_MEDIA_UNAVAILABLE')
    const badMeta = privateCrmMediaResolver({ baseUrl: 'http://crm-api:3000', token: 'fixture', fetch: vi.fn(async () => Response.json({ sha256: 'bad', size: 20 })) as typeof fetch })
    await expect(badMeta.preflight(SESSION, content('image'))).rejects.toThrow('CRM_PRIVATE_MEDIA_INVALID_METADATA')
  })
})
