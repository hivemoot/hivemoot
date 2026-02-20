#!/usr/bin/env bash
# Phase 2 host-side controller: spawn isolated worker containers per job.
set -euo pipefail

umask 077

log() {
  printf '[controller %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"

bash_major="${BASH_VERSINFO[0]:-0}"
if [ "$bash_major" -lt 4 ]; then
  echo "scripts/controller.sh requires Bash 4 or newer (found ${BASH_VERSION:-unknown})." >&2
  echo "On macOS, install a newer bash and run it explicitly (for example: /opt/homebrew/bin/bash scripts/controller.sh)." >&2
  exit 1
fi

require_non_negative_integer() {
  local name="$1"
  local value="$2"

  case "$value" in
    ''|*[!0-9]*)
      echo "${name} must be a non-negative integer" >&2
      exit 1
      ;;
  esac
}

require_positive_integer() {
  local name="$1"
  local value="$2"

  require_non_negative_integer "$name" "$value"
  if [ "$value" -le 0 ]; then
    echo "${name} must be > 0" >&2
    exit 1
  fi
}

sanitize_lock_key() {
  local value="$1"
  printf '%s' "$value" | tr -c 'A-Za-z0-9' '_'
}

ensure_repo_lock_file() {
  local repo="$1"
  local repo_key=""
  local repo_lock_file="${repo_lock_files[$repo]:-}"

  if [ -n "$repo_lock_file" ]; then
    return 0
  fi

  repo_key="$(sanitize_lock_key "$repo")"
  repo_lock_file="${lock_dir}/repo-${repo_key}.lock"
  mkdir -p "$(dirname "$repo_lock_file")"
  : > "$repo_lock_file"
  chmod 600 "$repo_lock_file" 2>/dev/null || true
  repo_lock_files["$repo"]="$repo_lock_file"
}

generate_job_id() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    tr '[:upper:]' '[:lower:]' < /proc/sys/kernel/random/uuid | head -n 1
    return 0
  fi

  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
    return 0
  fi

  # Fallback when uuid helpers are unavailable.
  printf 'job-%s-%s' "$(date +%s)" "$RANDOM"
}

write_job_spec() {
  local job_file="$1"
  local job_id="$2"
  local repo="$3"
  local agent_id="$4"
  local trigger_type="$5"
  local timeout_seconds="$6"

  cat > "$job_file" <<JSON
{
  "job_id": "${job_id}",
  "repo": "${repo}",
  "agent_id": "${agent_id}",
  "role": "${agent_id}",
  "trigger": {
    "type": "${trigger_type}"
  },
  "timeout_seconds": ${timeout_seconds}
}
JSON
}

write_job_status() {
  local job_workspace="$1"
  local job_id="$2"
  local repo="$3"
  local agent_id="$4"
  local trigger_type="$5"
  local status="$6"
  local exit_code="$7"

  local status_dir="${job_workspace}/.hivemoot"
  local status_file="${status_dir}/status"
  local summary_file="${status_dir}/summary"

  mkdir -p "$status_dir"

  printf '%s\n' "$status" > "$status_file"
  cat > "$summary_file" <<EOF_SUMMARY
job_id=${job_id}
repo=${repo}
agent_id=${agent_id}
trigger=${trigger_type}
status=${status}
exit_code=${exit_code}
updated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
EOF_SUMMARY
}

append_env_if_set() {
  local var_name="$1"
  local value="${!var_name:-}"

  if [ -n "$value" ]; then
    docker_run_args+=( -e "${var_name}=${value}" )
  fi
}

append_secret_env() {
  local var_name="$1"
  local file_var_name="${var_name}_FILE"
  local value="${!var_name:-}"
  local file_value="${!file_var_name:-}"

  if [ -n "$value" ] && [ -n "$file_value" ]; then
    echo "Set either ${var_name} or ${file_var_name}, not both." >&2
    return 1
  fi

  if [ -n "$file_value" ]; then
    case "$file_value" in
      /*) ;;
      *)
        echo "${file_var_name} must be an absolute path when mounting secret files: ${file_value}" >&2
        return 1
        ;;
    esac
    if [ ! -f "$file_value" ]; then
      echo "${file_var_name} does not exist: ${file_value}" >&2
      return 1
    fi
    docker_run_args+=( -v "${file_value}:${file_value}:ro" )
    docker_run_args+=( -e "${file_var_name}=${file_value}" )
    return 0
  fi

  if [ -n "$value" ]; then
    docker_run_args+=( -e "${var_name}=${value}" )
  fi
}

spawn_worker() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local job_workspace="$4"
  local job_home="$5"
  local token_file="$6"
  local extra_prompt="$7"

  local container_name="${worker_name_prefix}-${job_id}"
  local prompt_file="${AGENT_PROMPT_FILE:-}"

  docker_run_args=(
    run
    -d
    --name "${container_name}"
    --label "hivemoot.controller=true"
    --label "hivemoot.controller.instance=${controller_instance_id}"
    --label "hivemoot.job_id=${job_id}"
    --label "hivemoot.repo=${repo}"
    --cap-drop=ALL
    --security-opt=no-new-privileges
    --read-only
    --tmpfs "/tmp:size=2g,mode=1777"
    --tmpfs "/usr/local/share/npm-global:size=1g"
    --memory "${AGENT_MEMORY_LIMIT:-16g}"
    --cpus "${AGENT_CPU_LIMIT:-4.0}"
    --pids-limit "${AGENT_PIDS_LIMIT:-512}"
    -v "${job_workspace}:/workspace"
    -v "${job_home}:/home/node"
    -v "${token_file}:/run/secrets/agent_github_token:ro"
    -e RUN_MODE=once
    -e TARGET_REPO="${repo}"
    -e WORKSPACE_ROOT=/workspace
    -e JOB_ID="${job_id}"
    -e AGENT_ID_01="${agent_id}"
    -e AGENT_GITHUB_TOKEN_01_FILE=/run/secrets/agent_github_token
    -e AGENT_GIT_NAME="${agent_id}"
    -e AGENT_GIT_EMAIL="${agent_id}@${email_domain}"
    -e HIVEMOOT_BUZZ_ROLE="${agent_id}"
    -e HIVEMOOT_CLI_UPDATE=skip
    -e FRESH_CLONE="${FRESH_CLONE:-1}"
  )

  if [ -n "$extra_prompt" ]; then
    docker_run_args+=( -e "AGENT_EXTRA_PROMPT=${extra_prompt}" )
  fi

  append_env_if_set AGENT_PROVIDER
  append_env_if_set AGENT_AUTH_MODE
  append_env_if_set AGENT_MODEL
  append_env_if_set AGENT_PROMPT_FILE
  append_env_if_set AGENT_TIMEOUT_SECONDS
  append_env_if_set AGENT_TOOL_OPTIONS_JSON
  append_env_if_set GIT_CLONE_DEPTH
  append_env_if_set SESSION_RESUME
  append_env_if_set SESSION_RESUME_MAX_IDLE_HOURS
  append_env_if_set SESSION_RESUME_MAX_AGE_HOURS
  append_env_if_set KILO_PROVIDER
  append_env_if_set KILO_MODEL
  append_env_if_set OPENCODE_PROVIDER
  append_env_if_set OPENCODE_MODEL

  append_secret_env OPENAI_API_KEY
  append_secret_env GOOGLE_API_KEY
  append_secret_env GEMINI_API_KEY
  append_secret_env ANTHROPIC_API_KEY
  append_secret_env OPENROUTER_API_KEY
  append_secret_env CLAUDE_CODE_OAUTH_TOKEN
  append_secret_env KILOCODE_TOKEN
  append_secret_env ZAI_API_KEY

  if [ -n "$prompt_file" ] && [ -f "$prompt_file" ]; then
    case "$prompt_file" in
      /*) ;;
      *)
        echo "AGENT_PROMPT_FILE must be an absolute path when mounting custom prompts." >&2
        return 1
        ;;
    esac
    docker_run_args+=( -v "${prompt_file}:${prompt_file}:ro" )
  fi

  docker_run_args+=( "$worker_image" )

  "$docker_cmd" "${docker_run_args[@]}"
}

stop_controller_workers() {
  local -a container_ids=()

  if ! mapfile -t container_ids < <("$docker_cmd" ps -q --filter "label=hivemoot.controller.instance=${controller_instance_id}" 2>/dev/null); then
    return 0
  fi

  if [ "${#container_ids[@]}" -eq 0 ]; then
    return 0
  fi

  log "Stopping ${#container_ids[@]} running worker container(s)"
  "$docker_cmd" stop --time "$shutdown_grace_secs" "${container_ids[@]}" >/dev/null 2>&1 || true
}

cleanup_temp_tokens() {
  local path=""
  for path in "${temp_token_files[@]}"; do
    rm -f "$path" 2>/dev/null || true
  done
}

handle_shutdown() {
  if [ "$shutdown_requested" -ne 0 ]; then
    return 0
  fi

  shutdown_requested=1
  mkdir -p "$(dirname "$shutdown_flag_file")" 2>/dev/null || true
  : > "$shutdown_flag_file"
  log "Shutdown signal received; stopping new launches"
  stop_controller_workers
}

cleanup() {
  stop_controller_workers
  cleanup_temp_tokens
}

record_job_completion() {
  local pid="$1"
  local exit_code="$2"
  local job_id="${pid_to_job_id[$pid]:-unknown}"
  local repo="${pid_to_repo[$pid]:-unknown}"
  local agent_id="${pid_to_agent[$pid]:-unknown}"

  unset "pid_to_job_id[$pid]" "pid_to_repo[$pid]" "pid_to_agent[$pid]"

  if [ "$exit_code" -eq 0 ]; then
    completed_jobs=$((completed_jobs + 1))
    log "Job completed: id=${job_id} repo=${repo} agent=${agent_id}"
  else
    failed_jobs=$((failed_jobs + 1))
    log "Job failed: id=${job_id} repo=${repo} agent=${agent_id} exit=${exit_code}"
  fi
}

reap_finished_jobs() {
  local pid=""
  local job_exit=0
  local -a still_running=()

  for pid in "${running_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      still_running+=("$pid")
      continue
    fi

    if wait "$pid" 2>/dev/null; then
      job_exit=0
    else
      job_exit=$?
    fi

    record_job_completion "$pid" "$job_exit"
  done

  running_pids=("${still_running[@]}")
}

wait_for_available_slot() {
  while true; do
    if [ "$shutdown_requested" -ne 0 ]; then
      return 1
    fi

    reap_finished_jobs

    if [ "${#running_pids[@]}" -lt "$controller_max_workers" ]; then
      return 0
    fi

    sleep 1
  done
}

wait_for_all_jobs() {
  while [ "${#running_pids[@]}" -gt 0 ]; do
    reap_finished_jobs
    if [ "${#running_pids[@]}" -gt 0 ]; then
      sleep 1
    fi
  done
}

run_job() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local trigger_type="$4"
  local extra_prompt="$5"

  local token_file="${agent_token_files[$agent_id]}"
  local repo_lock_file="${repo_lock_files[$repo]:-}"
  local job_workspace="${workspaces_root}/${job_id}"
  local job_home="${homes_root}/${job_id}"
  local job_run_dir="${runs_root}/${job_id}"
  local job_spec_dir="${jobs_root}/${job_id}"
  local job_spec_file="${job_spec_dir}/job.json"
  local container_id=""
  local container_log_file="${job_run_dir}/container.log"
  local wait_output=""
  local wait_status=0
  local exit_code=125
  local log_pid=0
  local log_follow_deadline=0

  if [ -z "$repo_lock_file" ]; then
    ensure_repo_lock_file "$repo"
    repo_lock_file="${repo_lock_files[$repo]}"
  fi

  mkdir -p "$job_workspace" "$job_home" "$job_run_dir" "$job_spec_dir"
  chmod 700 "$job_workspace" "$job_home" "$job_run_dir" "$job_spec_dir" 2>/dev/null || true

  write_job_spec "$job_spec_file" "$job_id" "$repo" "$agent_id" "$trigger_type" "$agent_timeout_seconds"
  write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "queued" "-"

  exec 200>>"$repo_lock_file"
  flock 200

  if [ "$shutdown_requested" -ne 0 ] || [ -f "$shutdown_flag_file" ]; then
    log "Skipping queued job due to shutdown: id=${job_id} repo=${repo} agent=${agent_id}"
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "cancelled" "-"
    return 0
  fi

  write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "running" "-"

  if ! container_id="$(spawn_worker "$job_id" "$repo" "$agent_id" "$job_workspace" "$job_home" "$token_file" "$extra_prompt")"; then
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "failed" "125"
    return 125
  fi

  printf '%s\n' "$container_id" > "${job_run_dir}/container.id"
  log "Spawned worker: job=${job_id} container=${container_id} repo=${repo} agent=${agent_id}"

  "$docker_cmd" logs -f "$container_id" > "$container_log_file" 2>&1 &
  log_pid=$!

  if wait_output="$("$docker_cmd" wait "$container_id" 2>&1)"; then
    wait_status=0
  else
    wait_status=$?
  fi

  # Give `docker logs -f` a short grace window to exit naturally after container stop.
  if [ "$log_pid" -gt 0 ]; then
    log_follow_deadline=$((SECONDS + 2))
    while kill -0 "$log_pid" 2>/dev/null; do
      if [ "$SECONDS" -ge "$log_follow_deadline" ]; then
        kill "$log_pid" 2>/dev/null || true
        break
      fi
      sleep 0.1
    done
    wait "$log_pid" 2>/dev/null || true
  fi

  if [ "$wait_status" -ne 0 ]; then
    printf '%s\n' "$wait_output" > "${job_run_dir}/docker-wait-error.log"
    exit_code=125
  else
    exit_code="$(printf '%s\n' "$wait_output" | tail -n 1 | tr -d '\r')"
    case "$exit_code" in
      ''|*[!0-9]*)
        printf '%s\n' "$wait_output" > "${job_run_dir}/docker-wait-error.log"
        exit_code=125
        ;;
    esac
  fi

  "$docker_cmd" rm -f "$container_id" >/dev/null 2>&1 || true

  if [ "$exit_code" -eq 0 ]; then
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "completed" "$exit_code"
  else
    write_job_status "$job_workspace" "$job_id" "$repo" "$agent_id" "$trigger_type" "failed" "$exit_code"
  fi

  return "$exit_code"
}

launch_job() {
  local job_id="$1"
  local repo="$2"
  local agent_id="$3"
  local trigger_type="$4"
  local extra_prompt="$5"

  ensure_repo_lock_file "$repo"

  if ! wait_for_available_slot; then
    return 1
  fi

  (
    run_job "$job_id" "$repo" "$agent_id" "$trigger_type" "$extra_prompt"
  ) &

  local pid=$!
  running_pids+=("$pid")
  pid_to_job_id["$pid"]="$job_id"
  pid_to_repo["$pid"]="$repo"
  pid_to_agent["$pid"]="$agent_id"

  log "Queued job: id=${job_id} repo=${repo} agent=${agent_id} trigger=${trigger_type}"
}

run_periodic_cycle() {
  local agent_id=""
  local job_id=""

  log "Starting periodic cycle for ${agent_count} agent(s)"

  for agent_id in "${agent_ids[@]}"; do
    if [ "$shutdown_requested" -ne 0 ]; then
      break
    fi

    job_id="$(generate_job_id)"
    if ! launch_job "$job_id" "$target_repo" "$agent_id" "periodic" "$global_extra_prompt"; then
      break
    fi
  done

  wait_for_all_jobs

  log "Cycle done: completed=${completed_jobs} failed=${failed_jobs}"
}

next_cycle_delay() {
  local jitter="${periodic_jitter}"
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

# ── Configuration ──────────────────────────────────────────────────

docker_cmd="${DOCKER_BIN:-docker}"
worker_image="${WORKER_IMAGE:-hivemoot-agent:local}"
worker_name_prefix="${CONTROLLER_WORKER_NAME_PREFIX:-hivemoot-worker}"
controller_mode="${CONTROLLER_RUN_MODE:-once}"
controller_max_workers="${CONTROLLER_MAX_WORKERS:-1}"
periodic_interval="${PERIODIC_INTERVAL_SECS:-3600}"
periodic_jitter="${PERIODIC_JITTER_SECS:-300}"
shutdown_grace_secs="${CONTROLLER_SHUTDOWN_GRACE_SECS:-30}"
workspace_root="${CONTROLLER_WORKSPACE_ROOT:-${WORKSPACE_ROOT:-$(pwd)/data/controller}}"
shutdown_flag_file="${workspace_root}/shutdown.requested"
jobs_root="${workspace_root}/jobs"
runs_root="${workspace_root}/runs"
workspaces_root="${workspace_root}/workspaces"
homes_root="${workspace_root}/homes"
lock_dir="${CONTROLLER_LOCK_DIR:-/tmp/hivemoot-controller-locks}"
token_tmp_root="${CONTROLLER_TOKEN_TMP_ROOT:-/tmp/hivemoot-controller-token-files}"
email_domain="${AGENT_GIT_EMAIL_DOMAIN:-agents.local}"
global_extra_prompt="${AGENT_EXTRA_PROMPT:-}"
agent_timeout_seconds="${AGENT_TIMEOUT_SECONDS:-1800}"
target_repo="${TARGET_REPO:-}"
max_agents=10
controller_instance_id="$(date +%s)-$$"
shutdown_requested=0
completed_jobs=0
failed_jobs=0

declare -a temp_token_files=()
declare -a running_pids=()
declare -A pid_to_job_id=()
declare -A pid_to_repo=()
declare -A pid_to_agent=()
declare -A agent_token_files=()
declare -A repo_lock_files=()

case "$controller_mode" in
  once|loop) ;;
  *)
    echo "Unsupported CONTROLLER_RUN_MODE: ${controller_mode}. Use once|loop." >&2
    exit 1
    ;;
esac

require_positive_integer CONTROLLER_MAX_WORKERS "$controller_max_workers"
require_positive_integer AGENT_TIMEOUT_SECONDS "$agent_timeout_seconds"
require_positive_integer CONTROLLER_SHUTDOWN_GRACE_SECS "$shutdown_grace_secs"
require_positive_integer PERIODIC_INTERVAL_SECS "$periodic_interval"
require_non_negative_integer PERIODIC_JITTER_SECS "$periodic_jitter"

case "$workspace_root" in
  /*) ;;
  *)
    echo "CONTROLLER_WORKSPACE_ROOT must be an absolute path: ${workspace_root}" >&2
    exit 1
    ;;
esac

validate_target_repo "$target_repo"

if ! command -v "$docker_cmd" >/dev/null 2>&1; then
  echo "Missing required command: ${docker_cmd}" >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "Missing required command: flock" >&2
  exit 1
fi

mkdir -p "$jobs_root" "$runs_root" "$workspaces_root" "$homes_root" "$lock_dir" "$token_tmp_root"
chmod 700 "$workspace_root" "$jobs_root" "$runs_root" "$workspaces_root" "$homes_root" "$lock_dir" "$token_tmp_root" 2>/dev/null || true
rm -f "$shutdown_flag_file"
ensure_repo_lock_file "$target_repo"

declare -A seen_agents=()
declare -a agent_ids=()
declare -a agent_tokens=()

for slot in $(seq 1 "$max_agents"); do
  suffix="$(printf '%02d' "$slot")"
  id_var="AGENT_ID_${suffix}"
  token_var="AGENT_GITHUB_TOKEN_${suffix}"
  token_file_var="${token_var}_FILE"

  agent_id="$(trim "${!id_var:-}")"
  token_inline="${!token_var:-}"
  token_file="${!token_file_var:-}"

  if [ -z "$agent_id" ] && [ -z "$token_inline" ] && [ -z "$token_file" ]; then
    continue
  fi

  if [ -z "$agent_id" ]; then
    echo "${id_var} is required when ${token_var} or ${token_file_var} is set." >&2
    exit 1
  fi

  agent_token="$(load_slot_token "$suffix")"
  if [ -z "$agent_token" ]; then
    echo "Missing token for slot ${suffix}. Set ${token_var} or ${token_file_var}." >&2
    exit 1
  fi

  validate_agent_id "$agent_id"

  if [ -n "${seen_agents[$agent_id]:-}" ]; then
    echo "Duplicate agent id detected: ${agent_id}" >&2
    exit 1
  fi

  seen_agents["$agent_id"]=1
  agent_ids+=("$agent_id")
  agent_tokens+=("$agent_token")
done

if [ "${#agent_ids[@]}" -eq 0 ]; then
  echo "No agents configured. Set AGENT_ID_01 + AGENT_GITHUB_TOKEN_01 (up to _10)." >&2
  exit 1
fi

for index in "${!agent_ids[@]}"; do
  aid="${agent_ids[$index]}"
  token_value="${agent_tokens[$index]}"
  token_file="$(mktemp "${token_tmp_root}/${aid}.XXXXXX")"
  printf '%s' "$token_value" > "$token_file"
  chmod 600 "$token_file" 2>/dev/null || true
  temp_token_files+=("$token_file")
  agent_token_files["$aid"]="$token_file"
done

for slot in $(seq 1 "$max_agents"); do
  suffix="$(printf '%02d' "$slot")"
  unset "AGENT_GITHUB_TOKEN_${suffix}" "AGENT_GITHUB_TOKEN_${suffix}_FILE" || true
done

trap handle_shutdown TERM INT
trap cleanup EXIT

agent_count="${#agent_ids[@]}"

log "Controller starting: mode=${controller_mode} repo=${target_repo} agents=${agent_count} max_workers=${controller_max_workers}"
log "Worker image: ${worker_image}"
log "Workspace root: ${workspace_root}"
log "This controller runs on the host. Do not mount docker.sock into a container for controller execution."

run_periodic_cycle

if [ "$controller_mode" = "loop" ]; then
  while [ "$shutdown_requested" -eq 0 ]; do
    delay="$(next_cycle_delay)"
    log "Sleeping ${delay}s before next periodic cycle"
    sleep "$delay" &
    wait $! || true
    if [ "$shutdown_requested" -ne 0 ]; then
      break
    fi
    run_periodic_cycle
  done
fi

wait_for_all_jobs

if [ "$failed_jobs" -gt 0 ]; then
  log "Controller finished with failures: completed=${completed_jobs} failed=${failed_jobs}"
  exit 1
fi

log "Controller finished successfully: completed=${completed_jobs} failed=${failed_jobs}"
