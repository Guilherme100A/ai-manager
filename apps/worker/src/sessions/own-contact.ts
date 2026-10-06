import { ContactError, type ContactsService } from '@wsm/core'

export type OwnContactResult = 'created' | 'exists' | 'skipped'

/**
 * Chip próprio vira contato com consentimento ao conectar: sem isso, o pipeline barra as conversas entre chips
 * (CONTACT_NOT_ALLOWED) até alguém cadastrar o número à mão. Contato existente nunca é alterado (opt-out vale).
 */
export async function ensureOwnContact(
  contacts: Pick<ContactsService, 'findByPhone' | 'create'>,
  session: { name: string; phone: string | null },
): Promise<OwnContactResult> {
  if (!session.phone) return 'skipped'
  if (await contacts.findByPhone(session.phone)) return 'exists'
  try {
    await contacts.create({ name: `${session.name} (próprio)`, phone: session.phone, consent: true, consentSource: 'chip próprio do operador' })
    return 'created'
  } catch (err) {
    if (err instanceof ContactError && err.code === 'duplicate_phone') return 'exists'
    throw err
  }
}
