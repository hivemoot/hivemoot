#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[entrypoint %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"

for secret_var in \
  OPENAI_API_KEY \
  GOOGLE_API_KEY \
  GEMINI_API_KEY \
  ANTHROPIC_API_KEY \
  OPENROUTER_API_KEY \
  KILOCODE_TOKEN \
  ZAI_API_KEY
do
  load_secret_from_file "$secret_var"
done

mode="${RUN_MODE:-once}"
case "$mode" in
  once)
    log "Running multi-agent execution"
    exec /opt/hivemoot-agent/scripts/run-multi.sh
    ;;
  loop)
    log "Running loop mode"
    exec /opt/hivemoot-agent/scripts/run-loop.sh
    ;;
  *)
    echo "Invalid RUN_MODE: ${mode}. Expected: once|loop" >&2
    exit 1
    ;;
esac
