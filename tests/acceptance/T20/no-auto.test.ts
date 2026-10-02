import { addParticipant, adminWithGroup, api, targetSession, useGroupsApp } from './shared'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rootPath } from '../helpers/exec'

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo'])
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(n)) out.push(p)
  }
  return out
}
const rel = (f: string) => relative(rootPath(), f).split(sep).join('/')
const product = () => [...walk(rootPath('apps')), ...walk(rootPath('packages'))]
const nonTest = (f: string) => !/\.test\.tsx?$/.test(f)
// Fluxo de convite entre sessões e automação de grupos (posteriores ao T20): únicos módulos (e seus testes)
// que podem aceitar convite. Mesma lista do T14 (AC-T14-03).
const INVITE_FLOW_FILES = new Set(
  ['packages/core/src/transport/baileys', 'packages/core/src/transport/types', 'packages/core/src/groups/invites', 'apps/worker/src/groups/automation']
    .flatMap((f) => [`${f}.ts`, `${f}.unit.test.ts`]),
)

describe('T20 — sem adição automática e sem entrada em grupos', () => {
  const ctx = useGroupsApp()

  it('AC-T20-07 F-NO-GROUP-JOIN: o nome proibido de aceitar convite só aparece nos módulos do fluxo de convite (e seus testes)', () => {
    const forbidden = ['group', 'Accept', 'Invite'].join('')
    const hits = product()
      .filter((f) => readFileSync(f, 'utf8').includes(forbidden))
      .map(rel)
    expect(hits.filter((f) => !INVITE_FLOW_FILES.has(f)), `ocorrências fora do fluxo: ${hits.join(', ')}`).toEqual([])
  })

  it('AC-T20-03 a adição só é chamada a partir da rota/serviço: nenhum timer, fila, cron ou IA chama addGroupParticipant', () => {
    const callers = product()
      .filter(nonTest)
      .filter((f) => /addGroupParticipant\s*\(|addParticipant\s*\(|groupParticipantsUpdate\s*\(/.test(readFileSync(f, 'utf8')))
      .map(rel)
    // a camada de transporte implementa a adição; aqui interessam os CHAMADORES
    for (const f of callers.filter((c) => !c.startsWith('packages/core/src/transport/'))) {
      const src = readFileSync(rootPath(f), 'utf8')
      expect(/\bsetInterval\s*\(|\bcron\b|from\s+['"]bullmq['"]|new\s+Queue\s*\(|new\s+Worker\s*\(/.test(src), `${f} mistura adição com timer/fila`).toBe(false)
    }
    const suspicious = callers.filter((f) => /\/(ai|queue|warmup|health|alerts|send|safety|antiban)\//.test(f))
    expect(suspicious, `adição chamada por módulo automático: ${suspicious.join(', ')}`).toEqual([])
    // o dashboard só chama a rota (sem groupParticipantsUpdate direto)
    expect(callers.filter((f) => f.startsWith('apps/dashboard/') && /groupParticipantsUpdate/.test(readFileSync(rootPath(f), 'utf8')))).toEqual([])
  })

  it('AC-T20-03 groupParticipantsUpdate (Baileys) só é usado dentro da camada de transporte', () => {
    const users = product()
      .filter(nonTest)
      .filter((f) => /groupParticipantsUpdate/.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(users.length, 'o BaileysTransport deveria usar groupParticipantsUpdate').toBeGreaterThan(0)
    expect(users.filter((f) => !f.startsWith('packages/core/src/transport/'))).toEqual([])
  })

  it('AC-T20-07 conectar a sessão, receber mensagens de grupo e listar grupos não adiciona ninguém', async () => {
    const admin = await adminWithGroup(ctx)
    await targetSession(ctx)
    admin.transport.receive({ from: admin.groupId, participant: '5511999990000@s.whatsapp.net', text: 'adiciona o 5511988887777 aqui' })
    admin.transport.receive({ from: '5511999990001@s.whatsapp.net', text: 'me coloca no grupo https://chat.whatsapp.com/AbCdEfGh' })
    expect((await api(ctx, 'GET', `/api/sessions/${admin.id}/groups`)).status).toBe(200)
    expect((await api(ctx, 'POST', `/api/sessions/${admin.id}/groups/refresh`, {})).status).toBe(200)
    await new Promise((r) => setTimeout(r, 300))
    expect(admin.transport.groupAdds).toEqual([])
  })

  it('AC-T20-07 não existe rota de lote, agendamento ou entrada por convite', async () => {
    const admin = await adminWithGroup(ctx)
    const t = await targetSession(ctx)
    const gid = encodeURIComponent(admin.groupId)
    for (const [method, path, body] of [
      ['POST', `/api/sessions/${admin.id}/groups/${gid}/participants/bulk`, { targetSessionIds: [t.id] }],
      ['POST', `/api/sessions/${admin.id}/groups/participants`, { targetSessionId: t.id }],
      ['POST', `/api/sessions/${admin.id}/groups/${gid}/participants/schedule`, { targetSessionId: t.id, at: new Date().toISOString() }],
      ['POST', `/api/sessions/${admin.id}/groups/join`, { invite: 'AbCdEfGh' }],
      ['POST', `/api/sessions/${admin.id}/groups/${gid}/join`, {}],
      ['PUT', `/api/sessions/${admin.id}/groups/${gid}/participants`, { targetSessionId: t.id }],
    ] as const) {
      const r = await api(ctx, method, path, body)
      expect([400, 404, 405], `${method} ${path} → ${r.status} ${r.text}`).toContain(r.status)
    }
    expect(admin.transport.groupAdds).toEqual([])
    // a rota válida continua funcionando (prova de que as recusas acima não são por outro motivo)
    expect((await addParticipant(ctx, admin.id, admin.groupId, { targetSessionId: t.id })).status).toBe(200)
  })
})
