import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contacts, createDb, createTempDatabase, messages, sessions, type Database, type TempDatabase } from '@wsm/db'
import { ChatHistory, describeContent } from './chats'

let tmp: TempDatabase
let db: Database

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true, prefix: 'wsm_core_chats' })
  db = createDb(tmp.url, { max: 2 })
})

afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

describe('describeContent', () => {
  it('texto, mídia com e sem legenda, recebida', () => {
    expect(describeContent({ text: 'oi' })).toEqual({ text: 'oi', kind: 'text' })
    expect(describeContent({ text: 'oi', type: 'conversation' })).toEqual({ text: 'oi', kind: 'text' })
    expect(describeContent({ sticker: { url: '/x.webp' } })).toEqual({ text: null, kind: 'sticker' })
    expect(describeContent({ image: { url: 'u' }, caption: 'olha' })).toEqual({ text: 'olha', kind: 'image' })
    expect(describeContent(null)).toEqual({ text: null, kind: 'other' })
  })
})

describe('ChatHistory', () => {
  it('lista as conversas do chip com nome, contagens e última mensagem; mostra a conversa em ordem', async () => {
    const [a] = await db.insert(sessions).values({ name: 'chip A', phone: '+5531900000001' }).returning()
    const [b] = await db.insert(sessions).values({ name: 'chip B', phone: '+5531900000002' }).returning()
    await db.insert(contacts).values({ name: 'Fulano', phone: '+5531900000003' })
    const at = (min: number) => new Date(Date.UTC(2026, 9, 11, 12, min))
    await db.insert(messages).values([
      { sessionId: a!.id, phone: b!.phone!, direction: 'outbound', status: 'delivered', content: { text: 'opa' }, createdAt: at(1) },
      { sessionId: a!.id, phone: b!.phone!, direction: 'inbound', status: 'delivered', content: { text: 'e aí', type: 'conversation' }, createdAt: at(2) },
      { sessionId: a!.id, phone: '+5531900000003', direction: 'outbound', status: 'failed', content: { sticker: { url: '/s.webp' } }, error: 'blocked', createdAt: at(5) },
      { sessionId: a!.id, phone: '+5531900000004', direction: 'inbound', status: 'delivered', content: { text: 'quem?' }, createdAt: at(3) },
      // Outro chip: não aparece nas conversas do chip A.
      { sessionId: b!.id, phone: a!.phone!, direction: 'outbound', status: 'delivered', content: { text: 'e aí' }, createdAt: at(2) },
    ])
    const history = new ChatHistory(db)

    const list = await history.list(a!.id)
    expect(list.map((c) => c.phone)).toEqual(['+5531900000003', '+5531900000004', '+5531900000002'])
    expect(list[0]).toMatchObject({ name: 'Fulano', isSession: false, total: 1, sent: 1, received: 0, lastText: null, lastDirection: 'outbound' })
    expect(list[1]).toMatchObject({ name: null, isSession: false, received: 1, lastText: 'quem?' })
    expect(list[2]).toMatchObject({ name: 'chip B', isSession: true, total: 2, sent: 1, received: 1, lastText: 'e aí', lastDirection: 'inbound' })

    const thread = await history.messages(a!.id, b!.phone!)
    expect(thread.map((m) => [m.direction, m.text])).toEqual([['outbound', 'opa'], ['inbound', 'e aí']])
    expect(await history.messages(a!.id, b!.phone!, 1)).toHaveLength(1)
    expect((await history.messages(a!.id, '+5531900000003'))[0]).toMatchObject({ kind: 'sticker', status: 'failed', error: 'blocked' })
  })
})
