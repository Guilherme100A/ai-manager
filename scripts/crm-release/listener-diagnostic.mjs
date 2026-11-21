// Read-only Linux listener/process evidence. Never reads environ or signals a process.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const words = new Set(['node', 'nodejs', 'pnpm', 'npm', 'sh', 'bash', 'exec', 'preview', 'vite', 'vitest', 'playwright', 'test', 'run', 'build', '@crm/web', '127.0.0.1'])
const flags = new Set(['--host', '--port', '--strictPort', '--filter', '--import', '--conditions=development', '--config', '--project=desktop', '--project=mobile'])
export function sanitizeArgv(args) {
  return args.map((arg, i) => {
    if (i === 0) return ['node', 'nodejs', 'pnpm', 'sh', 'bash', 'esbuild'].includes(path.basename(arg)) ? path.basename(arg) : '[executable]'
    if (words.has(arg) || flags.has(arg) || args[i - 1] === '--port' && /^\d{1,5}$/.test(arg)) return arg
    const known = arg.match(/(?:^|\/)(scripts\/e2e\/(?:serve\.mjs|api\.ts)|vite\/bin\/vite\.js|pnpm\/(?:bin\/)?pnpm\.cjs|tsx\/dist\/cli\.mjs|vitest\/vitest\.mjs|playwright\/cli\.js)$/)
    if (known) return '<source>/' + known[1]
    // Inline shell/eval arguments may contain credentials. Report markers only.
    return '[redacted]'
  })
}
export function processIdentity(stat, argv) {
  const end = stat.lastIndexOf(')')
  const fields = stat.slice(end + 2).trim().split(/\s+/)
  return { pid: Number(stat.slice(0, stat.indexOf(' '))), ppid: Number(fields[1]), pgid: Number(fields[2]), argv: sanitizeArgv(argv) }
}
export function snapshot(procRoot = '/proc', childPid) {
  const listeners = new Map()
  for (const file of ['net/tcp', 'net/tcp6']) {
    for (const row of fs.readFileSync(path.join(procRoot, file), 'utf8').trim().split('\n').slice(1)) {
      const fields = row.trim().split(/\s+/)
      if (fields[3] === '0A') listeners.set(fields[9], { port: parseInt(fields[1].split(':').at(-1), 16), pids: [] })
    }
  }
  const processes = new Map()
  for (const pid of fs.readdirSync(procRoot).filter(n => /^\d+$/.test(n))) {
    try {
      const dir = path.join(procRoot, pid)
      const argv = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').split('\0').filter(Boolean)
      const identity = processIdentity(fs.readFileSync(path.join(dir, 'stat'), 'utf8'), argv)
      processes.set(identity.pid, identity)
      for (const fd of fs.readdirSync(path.join(dir, 'fd'))) {
        try {
          const inode = fs.readlinkSync(path.join(dir, 'fd', fd)).match(/^socket:\[(\d+)\]$/)?.[1]
          const listener = listeners.get(inode)
          if (listener && !listener.pids.includes(identity.pid)) listener.pids.push(identity.pid)
        } catch { /* process/fd exited during read */ }
      }
    } catch { /* process exited or belongs to an inaccessible user */ }
  }
  const selected = new Set([childPid])
  // Retain descendants before they reparent, plus the ancestors of actual listeners.
  let changed = true
  while (changed) {
    changed = false
    for (const p of processes.values()) if (selected.has(p.ppid) && !selected.has(p.pid)) { selected.add(p.pid); changed = true }
  }
  for (const listener of listeners.values()) for (let pid of listener.pids) {
    const seen = new Set()
    while (processes.has(pid) && !seen.has(pid)) {
      seen.add(pid); selected.add(pid); pid = processes.get(pid).ppid
    }
  }
  return { listeners: [...listeners.values()].sort((a, b) => a.port - b.port), processes: [...selected].filter(pid => processes.has(pid)).map(pid => processes.get(pid)).sort((a, b) => a.pid - b.pid) }
}

async function main() {
  if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') throw Error('Listener diagnosis is Linux CI-only')
  const [source, report, phase, executable, ...args] = process.argv.slice(2)
  if (!/^[a-z0-9-]+$/.test(phase) || !executable) throw Error('Expected source report phase command [args]')
  const { e2ePorts } = await import(pathToFileURL(path.resolve(source, 'scripts/e2e/ports.mjs')))
  const ports = e2ePorts(path.resolve(source))
  fs.mkdirSync(report, { recursive: true })
  const file = path.join(report, `listeners-${phase}.jsonl`)
  let last = '', diagnosisFailed = false
  const capture = (event, childPid) => {
    try {
      const state = snapshot('/proc', childPid), serialized = JSON.stringify(state)
      if (event !== 'during' || serialized !== last) {
        fs.appendFileSync(file, JSON.stringify({ phase, event, resolved_ports: ports, ...state }) + '\n')
        last = serialized
      }
    } catch {
      diagnosisFailed = true
      fs.appendFileSync(file, JSON.stringify({ phase, event, diagnostic_error: 'proc snapshot unavailable' }) + '\n')
    }
  }
  capture('before')
  const child = spawn(executable, args, { stdio: 'inherit' })
  capture('spawn', child.pid)
  const timer = setInterval(() => capture('during', child.pid), 250)
  try {
    const result = await new Promise(resolve => {
      child.once('error', () => resolve({ code: 1 }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    capture('after', child.pid)
    // Preserve command failure; a diagnosis failure must never turn a gate green.
    process.exitCode = result.code === 0 && !result.signal && !diagnosisFailed ? 0 : result.code || 1
  } finally { clearInterval(timer) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main()
