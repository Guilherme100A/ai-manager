#!/usr/bin/env bash
set -euo pipefail
[[ ${1:-} == --apply ]] || { echo 'Explicit --apply required; no operation performed' >&2; exit 2; }
# Shares the panel lock. Never starts the WhatsApp worker to pass a CRM preflight.
exec 9>"${AI_MANAGER_DEPLOY_LOCK:-/tmp/deploy-ai-manager.lock}"
flock -n 9 || { echo 'Deployment lock busy' >&2; exit 3; }
export CRM_RELEASE_LOCK_HELD=1
exec node "$(dirname "$0")/deploy.mjs" "${@:2}"
