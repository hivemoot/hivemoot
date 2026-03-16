#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[run-multi %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"
# shellcheck source=scripts/lib-slots.sh
. "${SCRIPT_DIR}/lib-slots.sh"

load_provider_secrets

# shellcheck source=scripts/opencode-helpers.sh
. "${SCRIPT_DIR}/opencode-helpers.sh"

workspace_root="${WORKSPACE_ROOT:-/workspace}"
global_extra_prompt="${AGENT_EXTRA_PROMPT:-}"
target_repo="${TARGET_REPO:-}"
launch_jitter_min="${LAUNCH_JITTER_MIN_SECS:-120}"
launch_jitter_max="${LAUNCH_JITTER_MAX_SECS:-180}"
max_agents=10
token_tmp_root="/tmp/hivemoot-agent-token-files"
provider="${AGENT_PROVIDER:-claude}"
auth_mode="${AGENT_AUTH_MODE:-auto}"
effective_auth_mode=""

case "$auth_mode" in
  auto|api_key|subscription) ;;
  *)
    echo "Unsupported AGENT_AUTH_MODE: ${auth_mode}. Use auto|api_key|subscription." >&2
    exit 1
    ;;
esac

if ! effective_auth_mode="$(resolve_effective_auth_mode "$provider" "$auth_mode")"; then
  echo "Unsupported auth mode/provider combination: provider=${provider} auth_mode=${auth_mode}" >&2
  exit 1
fi

require_non_negative_integer LAUNCH_JITTER_MIN_SECS "$launch_jitter_min"
require_non_negative_integer LAUNCH_JITTER_MAX_SECS "$launch_jitter_max"
if [ "$launch_jitter_max" -lt "$launch_jitter_min" ]; then
  echo "LAUNCH_JITTER_MAX_SECS (${launch_jitter_max}) must be >= LAUNCH_JITTER_MIN_SECS (${launch_jitter_min})" >&2
  exit 1
fi

validate_workspace_root "$workspace_root"
validate_target_repo "$target_repo"

declare -a temp_token_files=()
shutdown_requested=0

cleanup_temp_tokens() {
  local path=""
  for path in "${temp_token_files[@]-}"; do
    rm -f "$path" 2>/dev/null || true
  done
}

handle_shutdown() {
  if [ "$shutdown_requested" -eq 0 ]; then
    shutdown_requested=1
    log "Shutdown signal received; stopping new launches, waiting for running agents"
    for pid in "${pids[@]-}"; do
      kill -TERM "$pid" 2>/dev/null || true
    done
  fi
}

trap cleanup_temp_tokens EXIT
trap handle_shutdown TERM INT

shuffle_agents() {
  local i=0
  local j=0
  local tmp_id=""
  local tmp_token=""

  # Fisher-Yates shuffle in place.
  for ((i=${#agent_ids[@]} - 1; i>0; i--)); do
    j=$((RANDOM % (i + 1)))
    tmp_id="${agent_ids[i]}"
    tmp_token="${agent_tokens[i]}"
    agent_ids[i]="${agent_ids[j]}"
    agent_tokens[i]="${agent_tokens[j]}"
    agent_ids[j]="$tmp_id"
    agent_tokens[j]="$tmp_token"
  done
}

declare -A seen_agents=()
declare -A agent_skill_lists=()
declare -a agent_ids=()
declare -a agent_tokens=()
load_agent_slots "$max_agents"

mkdir -p "$token_tmp_root"
chmod 700 "$token_tmp_root" 2>/dev/null || true

for slot in $(seq 1 "$max_agents"); do
  suffix="$(printf '%02d' "$slot")"
  unset "AGENT_GITHUB_TOKEN_${suffix}" "AGENT_GITHUB_TOKEN_${suffix}_FILE" || true
done

shuffle_agents

agent_count="${#agent_ids[@]}"
log "Starting ${agent_count} agents in parallel (launch jitter: ${launch_jitter_min}-${launch_jitter_max}s)"
log "Target repo: ${target_repo}"
log "Randomized launch order: ${agent_ids[*]}"

preflight_check() {
  local provider="${AGENT_PROVIDER:-claude}"
  local auth_mode="${AGENT_AUTH_MODE:-auto}"
  local prompt_file="${AGENT_PROMPT_FILE:-/opt/hivemoot-agent/prompts/system/autonomous.md}"
  local failures=0

  log "Pre-flight: validating configuration"

  # Provider CLI installed
  if ! command -v "$provider" >/dev/null 2>&1; then
    echo "Pre-flight: ${provider} CLI is not installed in the container." >&2
    failures=$((failures + 1))
  fi

  if [ ! -f "$prompt_file" ]; then
    echo "Pre-flight: prompt file not found: ${prompt_file}" >&2
    failures=$((failures + 1))
  else
    # Built-in prompts require the shared base prompt; standalone custom
    # prompts remain valid without a sibling base.md.
    if ! resolve_companion_base_prompt "$prompt_file" >/dev/null; then
      if prompt_requires_companion_base "$prompt_file"; then
        echo "Pre-flight: base prompt file not found: $(dirname "$prompt_file")/base.md" >&2
        failures=$((failures + 1))
      fi
    fi
  fi

  # Skill files exist
  local skill_failures=0
  preflight_check_agent_skill_lists "/opt/hivemoot-agent/skills" || skill_failures=$?
  failures=$((failures + skill_failures))

  # Provider auth check
  local auth_failures=0
  preflight_check_provider_auth "$provider" "$auth_mode" || auth_failures=$?
  failures=$((failures + auth_failures))

  # Validate ALL agent tokens against GitHub API
  local index
  for index in "${!agent_ids[@]}"; do
    local aid="${agent_ids[$index]}"
    local tok="${agent_tokens[$index]}"

    if ! GH_TOKEN="$tok" gh api user --jq .login >/dev/null 2>&1; then
      if ! GH_TOKEN="$tok" gh api installation --jq .id >/dev/null 2>&1; then
        echo "Pre-flight: token for agent '${aid}' is invalid or expired." >&2
        failures=$((failures + 1))
        continue
      fi
    fi

    if [ -n "$target_repo" ]; then
      if ! GH_TOKEN="$tok" gh api "repos/${target_repo}" --jq .full_name >/dev/null 2>&1; then
        echo "Pre-flight: token for agent '${aid}' cannot access ${target_repo}." >&2
        failures=$((failures + 1))
      fi
    fi
  done

  if [ "$failures" -gt 0 ]; then
    echo "Pre-flight: ${failures} check(s) failed. Fix the above errors and retry." >&2
    exit 1
  fi

  log "Pre-flight: all checks passed (provider=${provider} auth=${auth_mode} repo=${target_repo} agents=${#agent_ids[@]})"
}

preflight_check
prepare_hivemoot_cli

declare -a pids=()
declare -A pid_to_agent=()
declare -A pid_to_wrapper_log=()
launch_index=0

for index in "${!agent_ids[@]}"; do
  agent_id="${agent_ids[$index]}"
  agent_token="${agent_tokens[$index]}"

  if [ "$launch_index" -gt 0 ]; then
    if [ "$shutdown_requested" -ne 0 ]; then
      log "Shutdown requested; skipping launch of ${agent_id}"
      break
    fi
    if [ "$launch_jitter_max" -gt 0 ]; then
      span=$((launch_jitter_max - launch_jitter_min + 1))
      delay=$((launch_jitter_min + RANDOM % span))
      log "Launch jitter before ${agent_id}: ${delay}s"
      sleep "$delay" &
      wait $! || true
      if [ "$shutdown_requested" -ne 0 ]; then
        log "Shutdown requested during jitter; skipping remaining agents"
        break
      fi
    fi
  fi

  token_file="$(mktemp "${token_tmp_root}/${agent_id}.XXXXXX")"
  printf '%s' "$agent_token" > "$token_file"
  chmod 600 "$token_file" 2>/dev/null || true
  temp_token_files+=("$token_file")

  agent_workspace="${workspace_root}/agents/${agent_id}"
  agent_repo="${agent_workspace}/repo"
  agent_log_dir="${workspace_root}/runs/${agent_id}"
  agent_home="$(resolve_managed_agent_home "$workspace_root" "$agent_id" "$effective_auth_mode")"
  wrapper_log="${agent_log_dir}/$(date '+%Y%m%d-%H%M%S')-${agent_id}-wrapper.log"
  agent_skills="$(resolve_agent_skill_list "$agent_id")"

  mkdir -p "$agent_workspace" "$agent_log_dir" "$agent_home"
  chmod 700 "$agent_workspace" "$agent_log_dir" "$agent_home" 2>/dev/null || true

  agent_extra_prompt="$global_extra_prompt"

  : > "$wrapper_log"
  chmod 600 "$wrapper_log" 2>/dev/null || true

  log "Launching agent=${agent_id} repo_dir=${agent_repo} log_dir=${agent_log_dir}"

  # Use a FIFO instead of process substitution to avoid a race condition
  # where early output can be lost before the async subshell opens FDs.
  agent_fifo="${agent_workspace}/output.fifo"
  rm -f "$agent_fifo"
  mkfifo "$agent_fifo"
  sed -u "s/^/[agent:${agent_id}] /" < "$agent_fifo" | tee -a "$wrapper_log" &

  (
    set -euo pipefail
    umask 077

    init_agent_home "$agent_home"

    unset AGENT_GITHUB_TOKEN GITHUB_TOKEN GH_TOKEN
    export HOME="$agent_home"
    export WORKSPACE_ROOT="$agent_workspace"
    export REPO_DIR="$agent_repo"
    export LOG_DIR="$agent_log_dir"
    export AGENT_GITHUB_TOKEN_FILE="$token_file"
    export AGENT_GIT_NAME="$agent_id"
    export HIVEMOOT_BUZZ_ROLE="$agent_id"
    export AGENT_EXTRA_PROMPT="$agent_extra_prompt"
    if [ -n "$agent_skills" ]; then
      export AGENT_SKILLS="$agent_skills"
    else
      unset AGENT_SKILLS
    fi

    exec /opt/hivemoot-agent/scripts/run-once.sh
  ) > "$agent_fifo" 2>&1 &

  pid="$!"
  pids+=("$pid")
  pid_to_agent["$pid"]="$agent_id"
  pid_to_wrapper_log["$pid"]="$wrapper_log"
  launch_index=$((launch_index + 1))
done

failures=0
for pid in "${pids[@]}"; do
  agent_id="${pid_to_agent[$pid]}"
  wrapper_log="${pid_to_wrapper_log[$pid]}"

  if wait "$pid" 2>/dev/null; then
    log "Agent ${agent_id} completed successfully"
  else
    exit_code=$?
    if [ "$shutdown_requested" -eq 1 ]; then
      log "Agent ${agent_id} terminated by shutdown"
    else
      failures=$((failures + 1))
      log "Agent ${agent_id} failed (exit=${exit_code}). Wrapper log: ${wrapper_log}"
    fi
  fi
done

if [ "$shutdown_requested" -ne 0 ]; then
  log "Shutdown drain complete"
  exit 0
fi

if [ "$failures" -gt 0 ]; then
  log "Completed with failures: ${failures}/${agent_count}"
  exit 1
fi

log "Completed successfully: ${agent_count}/${agent_count}"
