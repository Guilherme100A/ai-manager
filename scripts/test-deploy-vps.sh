#!/usr/bin/env bash
set -euo pipefail
deploy_script=$(cd "$(dirname "$0")" && pwd)/deploy-vps.sh
test_root=$(mktemp -d /tmp/ai-manager-deploy-test.XXXXXX)
trap 'case "$test_root" in /tmp/ai-manager-deploy-test.*) rm -rf -- "$test_root" ;; *) echo "Unsafe test cleanup path" >&2 ;; esac' EXIT
git init --quiet --bare --initial-branch=main "$test_root/origin.git"
git clone --quiet "$test_root/origin.git" "$test_root/repo" 2>/dev/null
cd "$test_root/repo"
git config user.name 'Deploy test'
git config user.email 'deploy-test@example.invalid'
printf 'services: {}\n' > docker-compose.yml
printf 'services: {}\n' > docker-compose.crm.yml
printf 'one\n' > version.txt
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
FLOCK
chmod +x "$test_root/bin/flock"
export PATH="$test_root/bin:$PATH"
export DEPLOY_TEST_LOG="$test_root/docker.log"
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
cat > "$test_root/bin/node" <<'NODE'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >> "$DEPLOY_TEST_LOG"
NODE
chmod +x "$test_root/bin/node"
bash "$deploy_script" "$integrated"
grep -q "compose.mjs $AI_MANAGER_DIR $CRM_RELEASE_STATE_DIR build worker api dashboard" "$DEPLOY_TEST_LOG"
[[ -f "$CRM_RELEASE_STATE_DIR/active.json" ]]
cp "$deploy_script" "$CRM_RELEASE_STATE_DIR/deploy-vps.sh"
entrypoint_script=$(dirname "$deploy_script")/crm-release/entrypoint.sh
SSH_ORIGINAL_COMMAND="~/deploy-ai-manager.sh $integrated" bash "$entrypoint_script"
if SSH_ORIGINAL_COMMAND="~/deploy-ai-manager.sh $next" bash "$entrypoint_script" >"$test_root/bootstrap-downgrade.log" 2>&1; then echo 'FAIL: stable external driver allowed missing integration'; exit 1; fi
echo 'PASS: dirty/remote/SHA/SSH checks; persisted CRM wrapper across next deploy and downgrade refusal (all Docker/Node calls mocked)'
