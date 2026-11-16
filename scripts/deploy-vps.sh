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
cd "$repo_dir"
git fetch --quiet origin main
git cat-file -e "$revision^{commit}"
git merge-base --is-ancestor "$revision" origin/main || { echo 'Commit fora de origin/main' >&2; exit 2; }
# Mudanças feitas diretamente na VPS precisam ser preservadas antes de trocar a versão.
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || {
  echo 'Deploy interrompido: há alterações locais na VPS. Nenhum arquivo foi descartado.' >&2
  exit 3
}
git checkout --quiet --detach "$revision"
compose=(docker compose -f docker-compose.yml)
[[ ! -f docker-compose.crm.yml ]] || compose+=(-f docker-compose.crm.yml)
"${compose[@]}" build worker api dashboard
"${compose[@]}" up -d --no-deps --wait worker api dashboard
printf '%s\n' "$revision" > "$state_file"
printf 'deploy ok: %s\n' "$revision"
