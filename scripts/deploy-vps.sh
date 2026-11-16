#!/usr/bin/env bash
set -euo pipefail

repo_dir=${AI_MANAGER_DIR:-$HOME/ai-manager}
state_file=${AI_MANAGER_DEPLOY_STATE:-$HOME/.ai-manager-deployed}
lock_file=${AI_MANAGER_DEPLOY_LOCK:-/tmp/deploy-ai-manager.lock}
revision=${1:-}
# Chaves SSH com command= executam um comando fixo; o pedido fica em SSH_ORIGINAL_COMMAND.
# Aceita somente o comando do workflow e um SHA completo, sem avaliar texto como shell.
if [[ -z "$revision" && "${SSH_ORIGINAL_COMMAND:-}" =~ ^\~/deploy-ai-manager\.sh[[:space:]]([0-9a-f]{40})$ ]]; then
  revision=${BASH_REMATCH[1]}
fi
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'SHA de deploy inválido' >&2; exit 2; }
exec 9>"$lock_file"
flock 9
release_state=${CRM_RELEASE_STATE_DIR:-$HOME/.config/ai-manager/crm-release}
[[ ! -e "$release_state/maintenance.json" ]] || { echo 'CRM maintenance unresolved' >&2; exit 4; }
cd "$repo_dir"
remote=${AI_MANAGER_REMOTE:-origin}
remote_url=$(git remote get-url "$remote")
[[ "$remote_url" == https://github.com/Guilherme100A/ai-manager.git || "$remote_url" == https://github.com/Guilherme100A/ai-manager || "$remote_url" == git@github.com:Guilherme100A/ai-manager.git ]] || { echo 'Wrong deployment repository' >&2; exit 2; }
git fetch --quiet "$remote" main
git cat-file -e "$revision^{commit}"
git merge-base --is-ancestor "$revision" "$remote/main" || { echo 'Commit fora da main alvo' >&2; exit 2; }
# Mudanças feitas diretamente na VPS precisam ser preservadas antes de trocar a versão.
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || {
  echo 'Deploy interrompido: há alterações locais na VPS. Nenhum arquivo foi descartado.' >&2
  exit 3
}
git checkout --quiet --detach "$revision"
# The active override lives outside Git, so checkout cannot discard a reviewed CRM release.
if [[ -f "$release_state/active.json" || -f "$release_state/maintenance.json" ]]; then
  [[ -f "$repo_dir/scripts/crm-release/compose.mjs" ]] || { echo 'Refusing a panel revision without CRM release integration' >&2; exit 4; }
  compose=(node "$repo_dir/scripts/crm-release/compose.mjs" "$repo_dir" "$release_state")
else
  compose=(docker compose -f docker-compose.yml)
  [[ ! -f docker-compose.crm.yml ]] || compose+=(-f docker-compose.crm.yml)
fi
"${compose[@]}" build worker api dashboard
"${compose[@]}" up -d --no-deps --wait worker api dashboard
printf '%s\n' "$revision" > "$state_file"
printf 'deploy ok: %s\n' "$revision"
