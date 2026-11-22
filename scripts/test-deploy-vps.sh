#!/usr/bin/env bash
set -euo pipefail
deploy_script=$(cd "$(dirname "$0")" && pwd)/deploy-vps.sh
test_root=$(mktemp -d "$(dirname "$deploy_script")/ai-manager-deploy-test.XXXXXX")
cleanup() {
  # Release only our own synthetic test build if an assertion fails mid-test.
  if [[ -n "${TEST_RELEASE_BUILD:-}" ]]; then touch "$TEST_RELEASE_BUILD"; fi
  if [[ -n "${first_pid:-}" ]]; then wait "$first_pid" || true; fi
  if [[ -n "${second_pid:-}" ]]; then wait "$second_pid" || true; fi
  case "$test_root" in "$(dirname "$deploy_script")"/ai-manager-deploy-test.*) rm -rf -- "$test_root" ;; *) echo 'Unsafe test cleanup path' >&2 ;; esac
}
trap cleanup EXIT
git init --quiet --bare --initial-branch=main "$test_root/origin.git"
git clone --quiet "$test_root/origin.git" "$test_root/repo" 2>/dev/null
cd "$test_root/repo"
git config user.name 'Deploy test'
git config user.email 'deploy-test@example.invalid'
printf 'services: {}\n' > docker-compose.yml
printf 'services: {}\n' > docker-compose.crm.yml
printf 'one\n' > version.txt
mkdir -p scripts
cp "$(dirname "$deploy_script")/deploy-disk.mjs" scripts/
git add . && git commit --quiet -m initial
first=$(git rev-parse HEAD)
git push --quiet origin main
printf 'two\n' > version.txt
git commit --quiet -am next
next=$(git rev-parse HEAD)
git push --quiet origin main
git checkout --quiet --detach "$first"
mkdir "$test_root/bin"
export REAL_GIT_FOR_TEST=$(command -v git)
export REAL_NODE_FOR_TEST=$(command -v node || command -v node.exe)
real_flock=$(command -v flock || true)
helper_tests="$(dirname "$deploy_script")/deploy-disk.test.mjs"
if [[ "$REAL_NODE_FOR_TEST" == *.exe ]] && command -v wslpath >/dev/null; then helper_tests=$(wslpath -w "$helper_tests"); fi
"$REAL_NODE_FOR_TEST" --test --test-reporter=dot "$helper_tests"
cat > "$test_root/bin/git" <<'GIT'
#!/usr/bin/env bash
if [[ "${1:-}" == remote && "${2:-}" == get-url ]]; then
  printf '%s\n' "${TEST_REMOTE_URL:-https://github.com/Guilherme100A/ai-manager.git}"
  exit 0
fi
exec "$REAL_GIT_FOR_TEST" "$@"
GIT
chmod +x "$test_root/bin/git"
cat > "$test_root/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DEPLOY_TEST_LOG"
DOCKER
chmod +x "$test_root/bin/docker"
cat > "$test_root/bin/flock" <<'FLOCK'
#!/usr/bin/env bash
[[ "${TEST_LOCK_BUSY:-0}" != 1 ]] || exit 75
printf 'locked\n' >> "$DEPLOY_TEST_LOCK_LOG"
FLOCK
chmod +x "$test_root/bin/flock"
# Execute the real helper with explicit POSIX/filesystem/Docker probe mocks.
# No daemon is contacted and no Windows UID/mode is treated as Linux evidence.
cat > "$test_root/probes.mjs" <<'PROBES'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { guard } = await import(pathToFileURL(process.argv[2]))
const repo = process.argv[3], env = process.env
const io = { ...fs, constants: { ...fs.constants, O_NOFOLLOW: 0 },
  lstatSync(p) { const s = fs.lstatSync(p); s.uid = 1000; s.mode = s.isDirectory() ? 0o40700 : 0o100600; return s },
  fstatSync(fd) { const s = fs.fstatSync(fd); s.uid = 1000; s.mode = 0o100600; return s },
}
let after = false
const run = (exe, args) => {
  if (!fs.readFileSync(env.DEPLOY_TEST_LOCK_LOG, 'utf8').includes('locked\n')) throw Error('probe before lock')
  const text = args.join(' ')
  fs.appendFileSync(env.DEPLOY_TEST_LOG, `probe ${exe} ${text}\n`)
  const scenario = env.TEST_DISK_SCENARIO
  let stdout = ''
  if (exe === 'df') {
    if (scenario === 'probe-failure') return { status: 19, stderr: 'SYNTHETIC_SECRET_DO_NOT_LOG' }
    const low = ['recover', 'insufficient', 'no-prune-low', 'no-confirm', 'concurrent', 'prune-fail', 'prune-timeout'].includes(scenario) && !(after && scenario === 'recover')
    stdout = `Avail Inodes IAvail\n${low ? 1 : 10 * 2 ** 30} 2000000 400000\n`
  } else if (text === 'context show') stdout = 'default'
  else if (text.includes('context inspect')) stdout = JSON.stringify('unix:///var/run/docker.sock')
  else if (text.includes('buildx inspect')) stdout = JSON.stringify({ Name: 'default', Driver: scenario === 'wrong-builder' ? 'docker-container' : 'docker', Nodes: [{ Endpoint: 'default', Status: 'running' }] })
  else if (text.includes('compose build --help')) stdout = '--builder string'
  else if (text.includes('info --format')) stdout = JSON.stringify(repo)
  else if (text.includes('prune --help')) return scenario?.startsWith('no-prune') ? { status: 1 } : { status: 0, stdout: '--all --force' }
  else if (text === '--context default builder prune --all --force') {
    after = true
    if (scenario === 'prune-fail') return { status: 18, stderr: 'SYNTHETIC_SECRET_DO_NOT_LOG' }
    if (scenario === 'prune-timeout') return { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } }
  } else throw Error('Unexpected mock probe')
  return { status: 0, stdout }
}
process.exitCode = guard({ repo, env: { ...env, AI_MANAGER_DISK_POLICY: path.join(path.dirname(repo), 'policy/deploy-disk.json') }, io, uid: 1000, run })
PROBES
export DEPLOY_TEST_PROBES="$test_root/probes.mjs"
cat > "$test_root/bin/node" <<'NODE'
#!/usr/bin/env bash
if [[ "$1" == */deploy-disk.mjs ]]; then
  if [[ "$REAL_NODE_FOR_TEST" == *.exe ]] && command -v wslpath >/dev/null; then
    export DEPLOY_TEST_LOG=$(wslpath -w "$DEPLOY_TEST_LOG")
    export DEPLOY_TEST_LOCK_LOG=$(wslpath -w "$DEPLOY_TEST_LOCK_LOG")
    export WSLENV="${WSLENV:+$WSLENV:}DEPLOY_TEST_LOG:DEPLOY_TEST_LOCK_LOG:TEST_DISK_SCENARIO:AI_MANAGER_BUILDER_LOCK_CONFIRMED:AI_MANAGER_BUILD_CONCURRENT"
    exec "$REAL_NODE_FOR_TEST" "$(wslpath -w "$DEPLOY_TEST_PROBES")" "$(wslpath -w "$1")" "$(wslpath -w "$2")"
  fi
  exec "$REAL_NODE_FOR_TEST" "$DEPLOY_TEST_PROBES" "$@"
fi
printf 'node %s\n' "$*" >> "$DEPLOY_TEST_LOG"
NODE
chmod +x "$test_root/bin/node"
export PATH="$test_root/bin:$PATH"
export DEPLOY_TEST_LOG="$test_root/docker.log"
export DEPLOY_TEST_LOCK_LOG="$test_root/lock.log"
export AI_MANAGER_DIR="$test_root/repo"
export AI_MANAGER_DEPLOY_STATE="$test_root/state"
export AI_MANAGER_DEPLOY_LOCK="$test_root/lock"
export CRM_RELEASE_STATE_DIR="$test_root/crm-release"
printf 'local change\n' > version.txt
if bash "$deploy_script" "$next" >"$test_root/dirty.log" 2>&1; then echo 'FAIL: dirty tree accepted'; exit 1; fi
grep -q 'local change' version.txt
[[ ! -e "$DEPLOY_TEST_LOG" && ! -e "$AI_MANAGER_DEPLOY_STATE" ]]
git restore version.txt
if TEST_LOCK_BUSY=1 bash "$deploy_script" "$next" >"$test_root/lock-busy.log" 2>&1; then echo 'FAIL: busy lock accepted'; exit 1; fi
if TEST_REMOTE_URL=https://github.com/rhgab1/ai-manager bash "$deploy_script" "$next" >"$test_root/wrong-remote.log" 2>&1; then echo 'FAIL: wrong GitHub remote accepted'; exit 1; fi
if bash "$deploy_script" invalid >"$test_root/invalid.log" 2>&1; then echo 'FAIL: invalid revision accepted'; exit 1; fi
bash "$deploy_script" "$next"
[[ "$(git rev-parse HEAD)" == "$next" && "$(cat "$AI_MANAGER_DEPLOY_STATE")" == "$next" ]]
grep -q 'two' version.txt
grep -q 'compose -f docker-compose.yml -f docker-compose.crm.yml build worker api dashboard' "$DEPLOY_TEST_LOG"
grep -q 'up -d --no-deps --wait worker api dashboard' "$DEPLOY_TEST_LOG"
git checkout --quiet --detach "$first"
SSH_ORIGINAL_COMMAND="~/deploy-ai-manager.sh $next" bash "$deploy_script"
[[ "$(git rev-parse HEAD)" == "$next" ]]
if SSH_ORIGINAL_COMMAND="echo $next" bash "$deploy_script" >"$test_root/ssh-invalid.log" 2>&1; then echo 'FAIL: arbitrary SSH command accepted'; exit 1; fi
mkdir -p "$CRM_RELEASE_STATE_DIR"
printf '{}\n' > "$CRM_RELEASE_STATE_DIR/active.json"
if bash "$deploy_script" "$next" >"$test_root/no-integration.log" 2>&1; then echo 'FAIL: old panel revision discarded CRM integration'; exit 1; fi
grep -q 'without CRM release integration' "$test_root/no-integration.log"
git checkout --quiet main
mkdir -p scripts/crm-release
printf '// mock integration marker\n' > scripts/crm-release/compose.mjs
git add . && git commit --quiet -m 'mock persistent integration'
integrated=$(git rev-parse HEAD)
git push --quiet origin main
bash "$deploy_script" "$integrated"
grep -q "compose.mjs $AI_MANAGER_DIR $CRM_RELEASE_STATE_DIR build worker api dashboard" "$DEPLOY_TEST_LOG"
[[ -f "$CRM_RELEASE_STATE_DIR/active.json" ]]
cp "$deploy_script" "$CRM_RELEASE_STATE_DIR/deploy-vps.sh"
entrypoint_script=$(dirname "$deploy_script")/crm-release/entrypoint.sh
SSH_ORIGINAL_COMMAND="~/deploy-ai-manager.sh $integrated" bash "$entrypoint_script"
if SSH_ORIGINAL_COMMAND="~/deploy-ai-manager.sh $next" bash "$entrypoint_script" >"$test_root/bootstrap-downgrade.log" 2>&1; then echo 'FAIL: stable external driver allowed missing integration'; exit 1; fi
echo 'PASS: dirty/remote/SHA/SSH checks; persisted CRM wrapper across next deploy and downgrade refusal (all Docker/Node calls mocked)'

for scenario in wrong-builder probe-failure insufficient no-prune-low no-confirm concurrent prune-fail prune-timeout; do
  : > "$DEPLOY_TEST_LOG"
  rm -f -- "$AI_MANAGER_DEPLOY_STATE"
  confirmed=1; [[ "$scenario" != no-confirm ]] || confirmed=0
  concurrent=0; [[ "$scenario" != concurrent ]] || concurrent=1
  if TEST_DISK_SCENARIO="$scenario" AI_MANAGER_BUILDER_LOCK_CONFIRMED="$confirmed" AI_MANAGER_BUILD_CONCURRENT="$concurrent" bash "$deploy_script" "$integrated" >"$test_root/$scenario.log" 2>&1; then echo "FAIL: $scenario accepted"; exit 1; fi
  [[ ! -e "$AI_MANAGER_DEPLOY_STATE" ]]
  ! grep -q 'build worker\|up -d' "$DEPLOY_TEST_LOG"
  ! grep -q SYNTHETIC_SECRET_DO_NOT_LOG "$test_root/$scenario.log"
done
for scenario in recover no-prune-high; do
  : > "$DEPLOY_TEST_LOG"
  TEST_DISK_SCENARIO="$scenario" AI_MANAGER_BUILDER_LOCK_CONFIRMED=1 bash "$deploy_script" "$integrated" >"$test_root/$scenario.log" 2>&1
  grep -q 'build worker api dashboard --builder default' "$DEPLOY_TEST_LOG"
  [[ "$(cat "$AI_MANAGER_DEPLOY_STATE")" == "$integrated" ]]
done
[[ "$(grep -c 'probe docker --context default builder prune --all --force$' "$test_root/docker.log" || true)" == 0 ]]
! grep -E 'docker (system|image|volume|container) prune|down -v' "$DEPLOY_TEST_LOG"
echo 'PASS: disk gate failures never build/up/write marker; restricted prune recovery and unavailable-above-floor; no synthetic secrets'

if [[ -n "$real_flock" ]]; then
  # Use the actual kernel lock for two complete wrapper executions, not a mock
  # that merely asserts flock was called. Hold the first build deterministically.
  cat > "$test_root/bin/flock" <<FLOCK
#!/usr/bin/env bash
"$real_flock" "\$@"
printf 'locked\n' >> "\$DEPLOY_TEST_LOCK_LOG"
FLOCK
  cat > "$test_root/bin/node" <<'NODE'
#!/usr/bin/env bash
if [[ "$1" == */deploy-disk.mjs ]]; then
  printf 'gate %s\n' "$TEST_RUN_ID" >> "$DEPLOY_TEST_LOG"
  exit 0
fi
if [[ "$*" == *' build '* ]]; then
  printf 'build %s\n' "$TEST_RUN_ID" >> "$DEPLOY_TEST_LOG"
  if [[ "$TEST_RUN_ID" == first ]]; then
    touch "$TEST_FIRST_BUILD"
    while [[ ! -e "$TEST_RELEASE_BUILD" ]]; do sleep 0.05; done
  fi
fi
if [[ "$*" == *' up '* ]]; then printf 'up %s\n' "$TEST_RUN_ID" >> "$DEPLOY_TEST_LOG"; fi
NODE
  chmod +x "$test_root/bin/flock" "$test_root/bin/node"
  export TEST_FIRST_BUILD="$test_root/first-build" TEST_RELEASE_BUILD="$test_root/release-build"
  : > "$DEPLOY_TEST_LOG"
  TEST_RUN_ID=first bash "$deploy_script" "$integrated" >"$test_root/first.log" 2>&1 & first_pid=$!
  for ((i=0; i<200; i++)); do [[ ! -e "$TEST_FIRST_BUILD" ]] || break; sleep 0.05; done
  [[ -e "$TEST_FIRST_BUILD" ]]
  TEST_RUN_ID=second bash "$deploy_script" "$integrated" >"$test_root/second.log" 2>&1 & second_pid=$!
  sleep 0.2
  ! grep -q second "$DEPLOY_TEST_LOG"
  touch "$TEST_RELEASE_BUILD"
  wait "$first_pid"; wait "$second_pid"
  [[ "$(cat "$DEPLOY_TEST_LOG")" == $'gate first\nbuild first\nup first\ngate second\nbuild second\nup second' ]]
  echo 'PASS: two real wrapper executions serialized through existing kernel flock, including gate/build/up'
else
  echo 'SKIP: real kernel flock unavailable on this host; run this suite on Linux for concurrency proof'
fi
