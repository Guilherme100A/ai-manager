import { describe, expect, it, vi } from 'vitest'
import { ContactError, type Contact } from '@wsm/core'
import { ensureOwnContact } from './own-contact'

function contacts(existing?: Partial<Contact>) {
  return {
    findByPhone: vi.fn(async () => existing as Contact | undefined),
    create: vi.fn(async () => ({}) as Contact),
  }
}

describe('chip próprio como contato', () => {
  it('cria com consentimento quando o número ainda não é contato', async () => {
    const c = contacts()
    expect(await ensureOwnContact(c, { name: 'chip 4', phone: '+553197302064' })).toBe('created')
    expect(c.create).toHaveBeenCalledWith({ name: 'chip 4 (próprio)', phone: '+553197302064', consent: true, consentSource: 'chip próprio do operador' })
  })
  it('contato existente nunca é alterado, nem com opt-out', async () => {
    const c = contacts({ phone: '+553197302064', consent: false, optOut: true })
    expect(await ensureOwnContact(c, { name: 'chip 4', phone: '+553197302064' })).toBe('exists')
    expect(c.create).not.toHaveBeenCalled()
  })
  it('sessão sem número não cria nada', async () => {
    const c = contacts()
    expect(await ensureOwnContact(c, { name: 'novo', phone: null })).toBe('skipped')
    expect(c.findByPhone).not.toHaveBeenCalled()
  })
  it('corrida com outro cadastro do mesmo número conta como existente', async () => {
    const c = contacts()
    c.create.mockRejectedValue(new ContactError('duplicate_phone', 'dup'))
    expect(await ensureOwnContact(c, { name: 'chip 4', phone: '+553197302064' })).toBe('exists')
  })
})
