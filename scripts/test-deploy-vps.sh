#!/usr/bin/env bash
set -euo pipefail
deploy_script=$(cd "$(dirname "$0")" && pwd)/deploy-vps.sh
test_root=$(mktemp -d /tmp/ai-manager-deploy-test.XXXXXX)
trap 'rm -rf "$test_root"' EXIT
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
cat > "$test_root/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DEPLOY_TEST_LOG"
DOCKER
chmod +x "$test_root/bin/docker"
export PATH="$test_root/bin:$PATH"
export DEPLOY_TEST_LOG="$test_root/docker.log"
export AI_MANAGER_DIR="$test_root/repo"
export AI_MANAGER_DEPLOY_STATE="$test_root/state"
export AI_MANAGER_DEPLOY_LOCK="$test_root/lock"
printf 'local change\n' > version.txt
if bash "$deploy_script" "$next" >"$test_root/dirty.log" 2>&1; then echo 'FAIL: dirty tree accepted'; exit 1; fi
grep -q 'local change' version.txt
[[ ! -e "$DEPLOY_TEST_LOG" && ! -e "$AI_MANAGER_DEPLOY_STATE" ]]
git restore version.txt
if bash "$deploy_script" invalid >"$test_root/invalid.log" 2>&1; then echo 'FAIL: invalid revision accepted'; exit 1; fi
bash "$deploy_script" "$next"
[[ "$(git rev-parse HEAD)" == "$next" && "$(cat "$AI_MANAGER_DEPLOY_STATE")" == "$next" ]]
grep -q 'two' version.txt
grep -q 'compose -f docker-compose.yml -f docker-compose.crm.yml build worker api dashboard' "$DEPLOY_TEST_LOG"
grep -q 'up -d --no-deps --wait worker api dashboard' "$DEPLOY_TEST_LOG"
echo 'PASS: local changes preserved; invalid SHA rejected; exact commit and CRM compose deployed'
