import { api, sessionWithGroups, useSessions } from './shared'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeTransport } from '@wsm/core'
import * as core from '@wsm/core'
import { rootPath } from '../helpers/exec'

// Montado por partes para este arquivo não conter o nome proibido literalmente.
const FORBIDDEN = ['group', 'Accept', 'Invite'].join('')
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage'])
const INVITE_FILES = new Set(['packages/core/src/transport/baileys.ts', 'packages/core/src/transport/types.ts', 'packages/core/src/groups/invites.ts'])
const EXTS = /\.(ts|tsx|js|mjs|cjs)$/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXTS.test(name)) out.push(p)
  }
  return out
}

describe('T14 — sem entrada automática em grupos', () => {
  const ctx = useSessions()

  it(`AC-T14-03 aceitar convite só aparece nos módulos do fluxo explícito (apps/**, packages/**)`, () => {
    const root = rootPath()
    const files = [...walk(rootPath('apps')), ...walk(rootPath('packages'))].filter((f) => !/\.test\.tsx?$/.test(f))
    expect(files.length).toBeGreaterThan(20)
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(FORBIDDEN)).map((f) => relative(root, f))
    expect(hits.filter((f) => !INVITE_FILES.has(f)), `ocorrências fora do fluxo: ${hits.join(', ')}`).toEqual([])
  })

  it('AC-T14-03 aceitar convite fica restrito aos módulos e testes do fluxo explícito', () => {
    const root = rootPath()
    const files = [...walk(rootPath('apps')), ...walk(rootPath('packages'))].filter((f) => !/\.test\.tsx?$/.test(f))
    const pattern = new RegExp(`${FORBIDDEN}|acceptInvite|groupJoin|joinGroup`, 'i')
    const hits = files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))
    expect(hits.filter((f) => !INVITE_FILES.has(f)), `ocorrências fora do fluxo: ${hits.join(', ')}`).toEqual([])
  })

  it('AC-T14-03 transporte e core não expõem operação de entrar/aceitar convite de grupo', () => {
    const t = new (FakeTransport as any)()
    const methods = new Set<string>()
    for (let p = t; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) methods.add(k)
    const joinish = [...methods].filter((m) => /accept|invite|join/i.test(m))
    expect(joinish, `métodos suspeitos no transporte: ${joinish.join(', ')}`).toEqual([])
    const coreJoin = Object.keys(core).filter((k) => /accept.*invite|join.*group|group.*join/i.test(k))
    expect(coreJoin).toEqual([])
  })

  it('AC-T14-03 a API não oferece rota de entrada em grupo (join/invite → 404)', async () => {
    const { id } = await sessionWithGroups(ctx)
    const gid = '120363000000000002@g.us'
    const attempts: Array<[string, string, unknown?]> = [
      ['POST', `/api/sessions/${id}/groups/join`, { invite: 'AbCdEfGhIjK' }],
      ['POST', `/api/sessions/${id}/groups/accept-invite`, { code: 'AbCdEfGhIjK' }],
      ['POST', `/api/sessions/${id}/groups/invite`, { code: 'AbCdEfGhIjK' }],
      ['POST', `/api/sessions/${id}/groups/${encodeURIComponent(gid)}/join`, {}],
      ['POST', `/api/sessions/${id}/groups`, { invite: 'https://chat.whatsapp.com/AbCdEfGhIjK' }],
      ['PUT', `/api/sessions/${id}/groups`, { invite: 'AbCdEfGhIjK' }],
    ]
    for (const [method, path, body] of attempts) {
      const res = await api(ctx, method, path, body)
      expect([404, 405], `${method} ${path} → ${res.status} ${res.text}`).toContain(res.status)
    }
  })
})
