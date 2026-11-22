import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const defaults = { format: 1, observed_peak_bytes: 0, observed_peak_inodes: 0 }
const fail = reason => { throw Object.assign(new Error(reason), { reason }) }
const integer = n => Number.isSafeInteger(n) && n >= 0
const requireThat = (ok, reason) => { if (!ok) fail(reason) }

export function parsePolicy(text) {
  let value
  try { value = JSON.parse(text) } catch { fail('policy_invalid') }
  requireThat(value && !Array.isArray(value) && typeof value === 'object', 'policy_invalid')
  // Values must be JSON integer literals. Count decoded keys before accepting
  // JSON.parse's object, which otherwise silently accepts duplicate keys.
  const pairs = [...text.matchAll(/("(?:\\.|[^"\\])*")\s*:\s*([^,}]+)/g)]
  const keys = pairs.map(p => JSON.parse(p[1]))
  requireThat(keys.length === 3 && new Set(keys).size === 3 && keys.every(k => Object.hasOwn(defaults, k)), 'policy_invalid')
  requireThat(pairs.every(p => /^(0|[1-9][0-9]*)$/.test(p[2].trim())), 'policy_invalid')
  requireThat(value.format === 1 && integer(value.observed_peak_bytes) && integer(value.observed_peak_inodes), 'policy_invalid')
  requireThat(value.observed_peak_bytes < Number.MAX_SAFE_INTEGER - 2147483648 && value.observed_peak_inodes < Number.MAX_SAFE_INTEGER - 25000, 'policy_overflow')
  return value
}

export function readPolicy(file, { io = fs, uid = process.geteuid?.() } = {}) {
  requireThat(path.isAbsolute(file) && integer(uid), 'policy_security')
  const directories = []
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    directories.unshift(dir)
    if (dir === path.dirname(dir)) break
  }
  const ancestors = []
  let missing = false
  for (const dir of directories) {
    let stat
    try { stat = io.lstatSync(dir) } catch (e) {
      if (e.code === 'ENOENT') { missing = true; continue }
      fail('policy_unreadable')
    }
    requireThat(!missing && stat.isDirectory() && !stat.isSymbolicLink() && [uid, 0].includes(stat.uid) && (stat.mode & 0o022) === 0, 'policy_security')
    if (path.basename(dir) === 'ai-manager') requireThat(stat.uid === uid && (stat.mode & 0o7777) === 0o700, 'policy_security')
    ancestors.push([dir, stat])
  }
  let before
  try { before = io.lstatSync(file) } catch (e) {
    if (e.code === 'ENOENT') return { policy: { ...defaults }, source: 'defaults' }
    fail('policy_unreadable')
  }
  const secureFile = s => s.isFile() && !s.isSymbolicLink() && s.uid === uid && (s.mode & 0o7777) === 0o600 && s.size <= 4096
  requireThat(secureFile(before) && !missing, 'policy_security')
  requireThat(typeof io.constants.O_NOFOLLOW === 'number', 'policy_security')
  let fd
  try {
    fd = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK)
    const opened = io.fstatSync(fd)
    requireThat(secureFile(opened) && before.dev === opened.dev && before.ino === opened.ino, 'policy_security')
    for (const [dir, stat] of ancestors) {
      const now = io.lstatSync(dir)
      requireThat(now.dev === stat.dev && now.ino === stat.ino && now.mode === stat.mode && now.uid === stat.uid && !now.isSymbolicLink(), 'policy_security')
    }
    // Bounded read even if the operator concurrently changes the policy file.
    const buffer = Buffer.alloc(4097)
    const size = io.readSync(fd, buffer, 0, buffer.length, 0)
    requireThat(size <= 4096, 'policy_security')
    const after = io.fstatSync(fd)
    requireThat(secureFile(after) && opened.size === after.size && opened.mtimeMs === after.mtimeMs, 'policy_security')
    return { policy: parsePolicy(buffer.subarray(0, size).toString('utf8')), source: 'file' }
  } catch (e) { if (e.reason) throw e; fail('policy_unreadable') } finally { if (fd !== undefined) io.closeSync(fd) }
}

export function thresholds(policy, totalInodes) {
  requireThat(integer(totalInodes) && totalInodes > 0, 'inodes_unavailable')
  return {
    min_free_bytes: Math.max(6442450944, policy.observed_peak_bytes + 2147483648),
    min_free_inodes: Math.max(100000, policy.observed_peak_inodes + 25000, Math.ceil(totalInodes / 20)),
  }
}

export function command(executable, args, timeout) {
  return spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout, killSignal: 'SIGKILL', maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] })
}
const outcome = r => ({ exitCode: Number.isInteger(r.status) ? r.status : null, signal: /^SIG[A-Z0-9]+$/.test(r.signal ?? '') ? r.signal : null, timeout: r.error?.code === 'ETIMEDOUT' })
const succeeded = r => r.status === 0 && !r.error && !r.signal

export function guard({ repo, env = process.env, io = fs, uid = process.geteuid?.(), home = os.userInfo().homedir, run = command, log = row => console.log(JSON.stringify(row)) }) {
  let phase = 'policy', pruneAttempted = false, loggingFailed = false
  const emit = fields => {
    try { log({ phase, prune_attempted: pruneAttempted, ...fields }) } catch { loggingFailed = true }
  }
  const probe = (exe, args) => {
    const r = run(exe, args, 15000)
    if (!succeeded(r)) { emit({ gate: 'fail', reason: 'probe_failed', ...outcome(r) }); fail('probe_failed') }
    return r.stdout?.trim() ?? ''
  }
  const json = text => { try { return JSON.parse(text) } catch { fail('probe_invalid') } }
  try {
    const file = env.AI_MANAGER_DISK_POLICY || path.join(home, '.config/ai-manager/deploy-disk.json')
    const relativePolicy = path.relative(io.realpathSync(repo), path.resolve(file))
    requireThat(relativePolicy === '..' || relativePolicy.startsWith('..' + path.sep) || path.isAbsolute(relativePolicy), 'policy_in_checkout')
    const { policy, source } = readPolicy(file, { io, uid })
    emit({ policy_source: source, ...policy })
    phase = 'identity'
    requireThat(!['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'BUILDX_BUILDER', 'COMPOSE_FILE'].some(k => env[k]), 'builder_unconfirmed')
    requireThat(!env.COMPOSE_BAKE || ['false', '0'].includes(env.COMPOSE_BAKE.toLowerCase()), 'builder_unconfirmed')
    requireThat(!env.DOCKER_BUILDKIT || env.DOCKER_BUILDKIT === '1', 'builder_unconfirmed')
    requireThat(probe('docker', ['context', 'show']) === 'default', 'builder_unconfirmed')
    const dc = ['--context', 'default']
    const endpoint = json(probe('docker', [...dc, 'context', 'inspect', 'default', '--format', '{{json .Endpoints.docker.Host}}']))
    requireThat(typeof endpoint === 'string' && /^unix:\/\/\/[^\s]+$/.test(endpoint), 'builder_unconfirmed')
    const builder = json(probe('docker', [...dc, 'buildx', 'inspect', 'default', '--format', '{{json .}}']))
    requireThat(builder.Name === 'default' && builder.Driver === 'docker' && !builder.Err && builder.Nodes?.length === 1 && builder.Nodes[0].Endpoint === 'default' && builder.Nodes[0].Status === 'running', 'builder_unconfirmed')
    requireThat(/--builder\b/.test(probe('docker', [...dc, 'compose', 'build', '--help'])), 'builder_unconfirmed')
    const root = json(probe('docker', [...dc, 'info', '--format', '{{json .DockerRootDir}}']))
    requireThat(typeof root === 'string' && path.isAbsolute(root), 'docker_root_unconfirmed')
    emit({ context: 'default', builder: 'default', driver: 'docker' })
    const targets = new Map()
    for (const [scope, dir] of [['repo', repo], ['docker', root]]) {
      let resolved, stat
      try { resolved = io.realpathSync(dir); stat = io.statSync(resolved) } catch { fail('filesystem_unavailable') }
      requireThat(stat.isDirectory() && integer(stat.dev), 'filesystem_unavailable')
      if (targets.has(stat.dev)) targets.get(stat.dev).scope = 'shared'
      else targets.set(stat.dev, { scope, dir: resolved })
    }
    const measure = when => {
      phase = when
      let pass = true
      for (const { scope, dir } of targets.values()) {
        // GNU df on the local Linux daemon host: avail excludes root's reserve,
        // iavail is available to the deployment user, not an invented infinity.
        const rows = probe('df', ['--local', '-B1', '--output=avail,itotal,iavail', '--', dir]).split('\n')
        requireThat(rows.length === 2, 'measurement_invalid')
        const cells = rows[1].trim().split(/\s+/)
        requireThat(cells.length === 3 && /^\d+$/.test(cells[0]), 'measurement_invalid')
        requireThat(cells.slice(1).every(n => /^\d+$/.test(n)), 'inodes_unavailable')
        const [bytes, total, inodes] = cells.map(Number)
        requireThat(integer(bytes), 'measurement_invalid')
        requireThat(integer(inodes) && integer(total) && total > 0 && inodes <= total, 'inodes_unavailable')
        const limits = thresholds(policy, total)
        const ok = bytes >= limits.min_free_bytes && inodes >= limits.min_free_inodes
        pass &&= ok
        emit({ filesystem_scope: scope, available_bytes: bytes, available_inodes: inodes, total_inodes: total, ...limits, alert: bytes < 8589934592 || inodes < limits.min_free_inodes, gate: ok ? 'pass' : 'fail', reason: ok ? 'sufficient' : 'below_floor' })
      }
      return pass
    }
    const sufficient = measure('before')
    phase = 'prune_probe'
    const supported = run('docker', [...dc, 'builder', 'prune', '--help'], 15000)
    if (!succeeded(supported) || !/--all\b/.test(supported.stdout ?? '') || !/--force\b/.test(supported.stdout ?? '')) {
      emit({ gate: sufficient ? 'pass' : 'fail', reason: 'prune_unavailable', ...outcome(supported) })
      requireThat(sufficient, 'prune_unavailable')
    } else if (!sufficient) {
      requireThat(!loggingFailed, 'log_failed')
      requireThat(env.AI_MANAGER_BUILDER_LOCK_CONFIRMED === '1', 'builder_lock_unconfirmed')
      // Operator declaration is not evidence of global exclusion. An explicit
      // report of concurrent activity always takes precedence over it.
      requireThat(!env.AI_MANAGER_BUILD_CONCURRENT || env.AI_MANAGER_BUILD_CONCURRENT === '0', 'concurrent_build')
      phase = 'prune'
      pruneAttempted = true
      const result = run('docker', [...dc, 'builder', 'prune', '--all', '--force'], 120000)
      emit({ gate: succeeded(result) ? 'pass' : 'fail', reason: succeeded(result) ? 'prune_completed' : 'prune_failed', ...outcome(result) })
      if (!succeeded(result)) {
        try { measure('after') } catch { /* Diagnostics never replace the prune failure. */ }
        fail('prune_failed')
      }
      requireThat(measure('after'), 'below_floor')
    }
    phase = 'gate'
    requireThat(!loggingFailed, 'log_failed')
    emit({ gate: 'pass', reason: 'sufficient' })
    requireThat(!loggingFailed, 'log_failed')
    return 0
  } catch (e) {
    emit({ gate: 'fail', reason: e.reason ?? 'probe_failed' })
    return 5
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = guard({ repo: process.argv[2] })
}
