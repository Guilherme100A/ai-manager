import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tsxCommand } from './lib.mjs'
test('actual runtime and migration command preserves development exports through the tsx child process', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-condition-fixture-'))
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'crm-condition-fixture-')); fs.rmSync(dir, { recursive: true }) })
  const pkg = path.join(dir, 'node_modules/condition-fixture')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'condition-fixture', type: 'module', exports: { development: './source.ts', default: './intentionally-not-built.js' } }))
  fs.writeFileSync(path.join(pkg, 'source.ts'), 'export default "development-export-loaded"\n')
  const entry = path.join(dir, 'entry.ts')
  fs.writeFileSync(entry, 'import value from "condition-fixture"; console.log(value,process.argv.slice(2).join(" "))\n')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const cli = process.env.TSX_CLI_PATH || path.join(root, 'node_modules/tsx/dist/cli.mjs')
  for (const tail of [[], ['--set', 'crm']]) {
    const args = tsxCommand(entry).slice(1); args[0] = cli
    const output = execFileSync(process.execPath, [...args, ...tail], { cwd: dir, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', windowsHide: true })
    assert.equal(output.trim(), ('development-export-loaded ' + tail.join(' ')).trim())
  }
})
