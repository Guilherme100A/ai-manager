// Suíte de contrato do CRM (perfil `ai-manager` do @crm/wa-gateway-rpc) contra o worker REAL deste repositório, em
// processo: WA_TRANSPORT=fake, CRM_BRIDGE=on, Postgres local (banco descartável) e stream próprio no Redis local.
// Precisa de um checkout do CRM com dependências instaladas (CRM_DIR, default ../crm-copy ao lado deste repo).
// Rodar a partir da raiz do ai-manager:
//   CRM_DIR=../crm-copy "$CRM_DIR/node_modules/.bin/vitest" run --config tests/crm-contract/vitest.config.mjs
// Não faz parte do `pnpm test` (depende do outro repositório).
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const crmDir = resolve(process.env.CRM_DIR ?? resolve(here, '../../../crm-copy'))
const { defineConfig } = await import(pathToFileURL(resolve(crmDir, 'node_modules/vitest/dist/config.js')).href)

export default defineConfig({
  root: here,
  resolve: {
    conditions: ['development'],
    alias: {
      vitest: resolve(crmDir, 'node_modules/vitest/dist/index.js'),
      '@crm-copy': crmDir,
    },
  },
  server: { fs: { strict: false } },
  test: {
    include: ['*.test.ts'],
    environment: 'node',
    env: { ANTIBAN_MODE: 'passthrough' },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
