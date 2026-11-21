import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeArgv, processIdentity } from './listener-diagnostic.mjs'

test('listener evidence retains pnpm/Vite lineage, ports and process group without credentials or inline source', () => {
  assert.deepEqual(processIdentity('123 (node (worker)) S 100 90 80 0 0', ['/usr/bin/node', '/crm/node_modules/vite/bin/vite.js', 'preview', '--port', '37778']), {
    pid: 123, ppid: 100, pgid: 90,
    argv: ['node', '<source>/vite/bin/vite.js', 'preview', '--port', '37778'],
  })
  const secret = 'synthetic-must-never-appear'
  const args = ['/usr/bin/node', '-e', `console.log('${secret}')`, '--token=' + secret, 'postgres://user:' + secret + '@localhost/db', secret]
  assert.ok(!JSON.stringify(sanitizeArgv(args)).includes(secret))
  assert.deepEqual(sanitizeArgv(['/bin/sh', '-c', `TOKEN=${secret} pnpm exec vite preview`]), ['sh', '[redacted]', '[redacted]'])
  assert.deepEqual(sanitizeArgv(['/usr/bin/node', '/crm/scripts/e2e/serve.mjs']), ['node', '<source>/scripts/e2e/serve.mjs'])
})
