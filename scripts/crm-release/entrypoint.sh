#!/usr/bin/env bash
set -euo pipefail
revision=${1:-}
if [[ -z "$revision" && "${SSH_ORIGINAL_COMMAND:-}" =~ ^\~/deploy-ai-manager\.sh[[:space:]]([0-9a-f]{40})$ ]]; then revision=${BASH_REMATCH[1]}; fi
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid deploy SHA/SSH command' >&2; exit 2; }
[[ ! -e "${CRM_RELEASE_STATE_DIR:-$HOME/.config/ai-manager/crm-release}/maintenance.json" ]] || { echo 'CRM maintenance unresolved' >&2; exit 4; }
# Installed outside Git together with its reviewed driver; checkout cannot revert this logic.
exec bash "${CRM_RELEASE_STATE_DIR:-$HOME/.config/ai-manager/crm-release}/deploy-vps.sh" "$revision"
