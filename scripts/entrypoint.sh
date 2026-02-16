#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[entrypoint %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

load_secret_from_file() {
  local var_name="$1"
  local file_var_name="${var_name}_FILE"
  local var_value="${!var_name:-}"
  local file_value="${!file_var_name:-}"

  if [ -n "$var_value" ] || [ -z "$file_value" ]; then
    return 0
  fi

  if [ ! -f "$file_value" ]; then
    echo "${file_var_name} is set but file does not exist: ${file_value}" >&2
    exit 1
  fi

  var_value="$(tr -d '\r\n' < "$file_value")"
  printf -v "$var_name" '%s' "$var_value"
  # shellcheck disable=SC2163  # dynamic export of the variable named in $var_name
  export "$var_name"
}

for secret_var in \
  OPENAI_API_KEY \
  GOOGLE_API_KEY \
  GEMINI_API_KEY \
  ANTHROPIC_API_KEY \
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
