#!/usr/bin/env bash
# Driver: loop — periodic single-agent execution. External triggers remain controller-owned.
set -euo pipefail

log() {
  printf '[run-loop %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
WORKER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${WORKER_DIR}/.." && pwd)"
SHARED_DIR="${SHARED_DIR:-${REPO_ROOT}/shared}"
KERNEL_DIR="${KERNEL_DIR:-${WORKER_DIR}}"
# shellcheck source=shared/lib.sh
. "${SHARED_DIR}/lib.sh"
# shellcheck source=shared/opencode-helpers.sh
. "${SHARED_DIR}/opencode-helpers.sh"

load_provider_secrets
load_identity_plugin
load_workload_plugin
load_workload_integration_preflight

workspace_root="${WORKSPACE_ROOT:-/workspace}"
global_extra_prompt="${AGENT_EXTRA_PROMPT:-}"
target_repo="${TARGET_REPO:-}"
provider="${AGENT_PROVIDER:-claude}"
auth_mode="${AGENT_AUTH_MODE:-auto}"
effective_auth_mode=""
run_once_script="${RUN_ONCE_SCRIPT:-${KERNEL_DIR}/run-once.sh}"
periodic_interval="${PERIODIC_INTERVAL_SECS:-${BASE_SECS:-3600}}"
periodic_jitter="${PERIODIC_JITTER_SECS:-${JITTER_SECS:-300}}"
max_failures="${MAX_CONSECUTIVE_FAILURES:-5}"
agent_failure_backoff_base="${PERIODIC_AGENT_FAILURE_BACKOFF_BASE_SECS:-300}"
agent_failure_backoff_max="${PERIODIC_AGENT_FAILURE_BACKOFF_MAX_SECS:-3600}"
agent_failure_backoff_jitter_pct="${PERIODIC_AGENT_FAILURE_BACKOFF_JITTER_PCT:-15}"
agent_id="${AGENT_ID:-${AGENT_ID_01:-}}"
agent_token_file="${AGENT_TOKEN_FILE:-${AGENT_GITHUB_TOKEN_01_FILE:-}}"
agent_token_inline="${AGENT_TOKEN:-${AGENT_GITHUB_TOKEN_01:-}}"
agent_workspace=""
agent_repo=""
agent_log_dir=""
agent_home=""
resolved_agent_skills="${AGENT_SKILLS:-${AGENT_SKILLS_01:-}}"
agent_run_busy_exit=3
lock_dir="/tmp/agent-locks"
shutdown_requested=0
consecutive_failures=0
next_retry_at=0

declare -a temp_token_files=()

case "$auth_mode" in
  auto|api_key|subscription) ;;
  *)
    echo "Unsupported AGENT_AUTH_MODE: ${auth_mode}. Use auto|api_key|subscription." >&2
    exit 1
    ;;
esac

if [ "${WATCH_MENTIONS:-0}" = "1" ] || [ "${WATCH_REVIEW_REQUESTS:-0}" = "1" ] || [ "${WATCH_TASKS:-0}" = "1" ]; then
  echo "Worker loop driver is periodic execution only. Use controller/main.sh for mention, review-request, or task triggers." >&2
  exit 1
fi

if [ -z "$agent_id" ]; then
  echo "AGENT_ID is required for AGENT_DRIVER=loop (legacy fallback: AGENT_ID_01)." >&2
  exit 1
fi
validate_agent_id "$agent_id"

if [ -z "$agent_token_file" ] && [ -z "$agent_token_inline" ] && [ -z "${AGENT_GITHUB_TOKEN_FILE:-}" ] && [ -z "${AGENT_GITHUB_TOKEN:-}" ]; then
  echo "AGENT_TOKEN_FILE or AGENT_TOKEN is required for AGENT_DRIVER=loop." >&2
  echo "Legacy fallback: AGENT_GITHUB_TOKEN_01(_FILE) is still accepted." >&2
  exit 1
fi

if ! effective_auth_mode="$(resolve_effective_auth_mode "$provider" "$auth_mode")"; then
  echo "Unsupported auth mode/provider combination: provider=${provider} auth_mode=${auth_mode}" >&2
  exit 1
fi

require_positive_integer PERIODIC_INTERVAL_SECS "$periodic_interval"
require_non_negative_integer PERIODIC_JITTER_SECS "$periodic_jitter"
require_positive_integer MAX_CONSECUTIVE_FAILURES "$max_failures"
require_non_negative_integer PERIODIC_AGENT_FAILURE_BACKOFF_BASE_SECS "$agent_failure_backoff_base"
require_positive_integer PERIODIC_AGENT_FAILURE_BACKOFF_MAX_SECS "$agent_failure_backoff_max"
require_non_negative_integer PERIODIC_AGENT_FAILURE_BACKOFF_JITTER_PCT "$agent_failure_backoff_jitter_pct"

if [ "$agent_failure_backoff_base" -gt "$agent_failure_backoff_max" ]; then
  echo "PERIODIC_AGENT_FAILURE_BACKOFF_BASE_SECS must be <= PERIODIC_AGENT_FAILURE_BACKOFF_MAX_SECS" >&2
  exit 1
fi
if [ "$agent_failure_backoff_jitter_pct" -gt 100 ]; then
  echo "PERIODIC_AGENT_FAILURE_BACKOFF_JITTER_PCT must be between 0 and 100" >&2
  exit 1
fi

validate_workspace_root "$workspace_root"
validate_target_repo "$target_repo"

if [ -n "$agent_token_file" ]; then
  integration_prepare_agent_env "$agent_token_file"
elif [ -n "$agent_token_inline" ]; then
  export AGENT_GITHUB_TOKEN="$agent_token_inline"
fi

if [ -n "${AGENT_TOKEN_FILE:-}" ]; then
  export AGENT_TOKEN_FILE
fi
export AGENT_ID="$agent_id"

agent_workspace="${workspace_root}/agents/${agent_id}"
agent_repo="${agent_workspace}/repo"
agent_log_dir="${workspace_root}/runs/${agent_id}"
agent_home="$(resolve_managed_agent_home "$workspace_root" "$agent_id" "$effective_auth_mode")"

mkdir -p "$agent_workspace" "$agent_log_dir" "$agent_home" "$lock_dir"
init_agent_home "$agent_home"

cleanup() {
  cleanup_temp_tokens
}

handle_shutdown() {
  if [ "$shutdown_requested" -eq 0 ]; then
    shutdown_requested=1
    log "Shutdown signal received; exiting after the current sleep or run"
  fi
}

trap cleanup EXIT
trap handle_shutdown TERM INT

preflight_check() {
  local failures=0
  local workload_failures=0
  local auth_failures=0

  log "Pre-flight: validating configuration"

  if ! command -v "$provider" >/dev/null 2>&1; then
    echo "Pre-flight: ${provider} CLI is not installed in the container." >&2
    failures=$((failures + 1))
  fi

  workload_preflight || workload_failures=$?
  failures=$((failures + workload_failures))

  preflight_check_provider_auth "$provider" "$auth_mode" || auth_failures=$?
  failures=$((failures + auth_failures))

  if [ "$failures" -gt 0 ]; then
    echo "Pre-flight: ${failures} check(s) failed. Fix the above errors and retry." >&2
    exit 1
  fi

  log "Pre-flight: all checks passed (provider=${provider} auth=${effective_auth_mode} agent=${agent_id} repo=${target_repo})"
}

calculate_backoff_delay() {
  local failure_count="$1"
  local delay="$agent_failure_backoff_base"

  if [ "$failure_count" -le 0 ] || [ "$delay" -le 0 ]; then
    echo 0
    return 0
  fi

  local attempt=0
  for ((attempt = 1; attempt < failure_count; attempt++)); do
    if [ "$delay" -ge "$agent_failure_backoff_max" ]; then
      delay="$agent_failure_backoff_max"
      break
    fi
    delay=$((delay * 2))
  done

  if [ "$delay" -gt "$agent_failure_backoff_max" ]; then
    delay="$agent_failure_backoff_max"
  fi

  if [ "$agent_failure_backoff_jitter_pct" -gt 0 ] && [ "$delay" -gt 0 ]; then
    local jitter=$((delay * agent_failure_backoff_jitter_pct / 100))
    if [ "$jitter" -gt 0 ]; then
      local span=$((jitter * 2 + 1))
      local offset=$((RANDOM % span - jitter))
      delay=$((delay + offset))
      if [ "$delay" -lt 1 ]; then
        delay=1
      fi
    fi
  fi

  echo "$delay"
}

next_cycle_delay() {
  local jitter="$periodic_jitter"
  local min_delay=""
  local max_delay=""
  local span=""

  if [ "$periodic_interval" -le 1 ]; then
    echo 1
    return 0
  fi

  if [ "$jitter" -ge "$periodic_interval" ]; then
    jitter=$((periodic_interval - 1))
  fi

  min_delay=$((periodic_interval - jitter))
  max_delay=$((periodic_interval + jitter))
  span=$((max_delay - min_delay + 1))
  echo $((min_delay + RANDOM % span))
}

try_run_once() {
  local lock_file="${lock_dir}/${agent_id}.lock"
  (
    flock -n 200 || { log "${agent_id}: busy, skipping"; exit "$agent_run_busy_exit"; }

    log "${agent_id}: lock acquired, starting run"

    export HOME="$agent_home"
    export WORKSPACE_ROOT="$agent_workspace"
    export REPO_DIR="$agent_repo"
    export LOG_DIR="$agent_log_dir"
    export AGENT_ID="$agent_id"
    export AGENT_EXTRA_PROMPT="$global_extra_prompt"
    export AGENT_CONSECUTIVE_FAILURES="$consecutive_failures"
    export PERIODIC_INTERVAL_SECS="$periodic_interval"
    export RUN_TRIGGER_TYPE="scheduled"
    if [ -n "$resolved_agent_skills" ]; then
      export AGENT_SKILLS="$resolved_agent_skills"
    else
      unset AGENT_SKILLS
    fi

    local agent_exit=0
    "$run_once_script" || agent_exit=$?
    if [ "$agent_exit" -ne 0 ]; then
      log "${agent_id}: run exited with code ${agent_exit}"
    fi

    log "${agent_id}: lock released"
    exit "$agent_exit"
  ) 200>"$lock_file"
}

preflight_check

log "Loop mode starting: agent=${agent_id} repo=${target_repo}"
log "  Periodic interval: ${periodic_interval}s +/-${periodic_jitter}s"
log "  Periodic failure backoff: base=${agent_failure_backoff_base}s max=${agent_failure_backoff_max}s jitter=${agent_failure_backoff_jitter_pct}%"
log "  Max consecutive failures: ${max_failures}"

while [ "$shutdown_requested" -eq 0 ]; do
  local_delay="$(next_cycle_delay)"
  log "Periodic[${agent_id}]: sleeping ${local_delay}s"
  sleep "$local_delay" &
  wait $! || true

  if [ "$shutdown_requested" -ne 0 ]; then
    break
  fi

  now_epoch="$(date +%s)"
  if [ "$next_retry_at" -gt "$now_epoch" ]; then
    remaining=$((next_retry_at - now_epoch))
    log "Periodic[${agent_id}]: in cooldown (${remaining}s remaining), skipping"
    continue
  fi

  run_status=0
  try_run_once || run_status=$?

  if [ "$run_status" -eq 0 ]; then
    if [ "$consecutive_failures" -gt 0 ]; then
      log "Periodic[${agent_id}]: recovered after ${consecutive_failures} failure(s)"
    fi
    consecutive_failures=0
    next_retry_at=0
    continue
  fi

  if [ "$run_status" -eq "$agent_run_busy_exit" ]; then
    log "Periodic[${agent_id}]: busy, keeping backoff state"
    continue
  fi

  consecutive_failures=$((consecutive_failures + 1))
  backoff_delay="$(calculate_backoff_delay "$consecutive_failures")"
  failure_epoch="$(date +%s)"
  next_retry_at=$((failure_epoch + backoff_delay))

  if [ "$backoff_delay" -gt 0 ]; then
    log "Periodic[${agent_id}]: failed (${consecutive_failures}x); cooldown ${backoff_delay}s"
  else
    log "Periodic[${agent_id}]: failed (${consecutive_failures}x); retrying next cycle"
  fi

  if [ "$consecutive_failures" -ge "$max_failures" ]; then
    log "Periodic[${agent_id}]: reached max failures (${max_failures}); exiting"
    exit 1
  fi
done

log "Graceful shutdown complete"
