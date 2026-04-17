#!/usr/bin/env bash
# Phase 2 host-side controller: spawn isolated worker containers per job.
set -euo pipefail

umask 077

log() {
  printf '[controller %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SHARED_DIR="${SHARED_DIR:-${REPO_ROOT}/shared}"
CORE_DIR="${CORE_DIR:-${SCRIPT_DIR}/core}"
TRIGGER_DIR="${TRIGGER_DIR:-${SCRIPT_DIR}/triggers}"

# shellcheck source=shared/lib.sh
. "${SHARED_DIR}/lib.sh"
# shellcheck source=shared/lib-global-slots.sh
. "${SHARED_DIR}/lib-global-slots.sh"
# shellcheck source=shared/lib-slots.sh
. "${SHARED_DIR}/lib-slots.sh"
# shellcheck source=shared/lib-classify.sh
. "${SHARED_DIR}/lib-classify.sh"
# shellcheck source=shared/health-reporter.sh
. "${SHARED_DIR}/health-reporter.sh"

bash_major="${BASH_VERSINFO[0]:-0}"
print_bash_upgrade_hint() {
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "On macOS, install a newer bash: brew install bash" >&2
    echo "Then run it explicitly (Apple Silicon: /opt/homebrew/bin/bash controller/main.sh; Intel: /usr/local/bin/bash controller/main.sh)." >&2
    return 0
  fi

  if command -v apt >/dev/null 2>&1 || command -v apt-get >/dev/null 2>&1; then
    echo "Install a newer bash: sudo apt install bash" >&2
  elif command -v dnf >/dev/null 2>&1; then
    echo "Install a newer bash: sudo dnf install bash" >&2
  elif command -v yum >/dev/null 2>&1; then
    echo "Install a newer bash: sudo yum install bash" >&2
  elif command -v apk >/dev/null 2>&1; then
    echo "Install a newer bash: sudo apk add bash" >&2
  elif command -v pacman >/dev/null 2>&1; then
    echo "Install a newer bash: sudo pacman -S bash" >&2
  elif command -v zypper >/dev/null 2>&1; then
    echo "Install a newer bash: sudo zypper install bash" >&2
  elif command -v pkg >/dev/null 2>&1; then
    echo "Install a newer bash: sudo pkg install bash" >&2
  else
    echo "Install Bash 4+ with your package manager." >&2
  fi

  echo "Then rerun this script with the upgraded Bash binary." >&2
}

if [ "$bash_major" -lt 4 ]; then
  echo "controller/main.sh requires Bash 4 or newer (found ${BASH_VERSION:-unknown})." >&2
  print_bash_upgrade_hint
  exit 1
fi

# shellcheck source=controller/triggers/common.sh
. "${TRIGGER_DIR}/common.sh"
# shellcheck source=controller/triggers/github-common.sh
. "${TRIGGER_DIR}/github-common.sh"
# shellcheck source=controller/triggers/github-mention.sh
. "${TRIGGER_DIR}/github-mention.sh"
# shellcheck source=controller/triggers/github-review-request.sh
. "${TRIGGER_DIR}/github-review-request.sh"
# shellcheck source=controller/triggers/hivemoot-task.sh
. "${TRIGGER_DIR}/hivemoot-task.sh"
# shellcheck source=controller/triggers/periodic.sh
. "${TRIGGER_DIR}/periodic.sh"
# shellcheck source=controller/triggers/messaging.sh
. "${TRIGGER_DIR}/messaging.sh"

# shellcheck source=controller/core/common.sh
. "${CORE_DIR}/common.sh"
# shellcheck source=controller/core/jobs.sh
. "${CORE_DIR}/jobs.sh"
# shellcheck source=controller/core/queue.sh
. "${CORE_DIR}/queue.sh"
# shellcheck source=controller/core/runtime.sh
. "${CORE_DIR}/runtime.sh"

# ── Configuration ──────────────────────────────────────────────────

docker_cmd="${DOCKER_BIN:-docker}"
worker_image="${WORKER_IMAGE:-hivemoot-agent:local}"
worker_name_prefix="${CONTROLLER_WORKER_NAME_PREFIX:-hivemoot-worker}"
controller_mode="${CONTROLLER_RUN_MODE:-once}"
controller_max_workers="${CONTROLLER_MAX_WORKERS:-1}"
global_max_workers="${GLOBAL_MAX_WORKERS:-0}"
global_slots_dir="${GLOBAL_SLOTS_DIR:-}"
global_slot_timeout_periodic_secs="${GLOBAL_SLOT_TIMEOUT_PERIODIC_SECS:-300}"
global_slot_timeout_mention_secs="${GLOBAL_SLOT_TIMEOUT_MENTION_SECS:-600}"
global_slot_timeout_task_secs="${GLOBAL_SLOT_TIMEOUT_TASK_SECS:-600}"
periodic_interval="${PERIODIC_INTERVAL_SECS:-3600}"
periodic_jitter="${PERIODIC_JITTER_SECS:-300}"
watch_mentions="${WATCH_MENTIONS:-0}"
watch_review_requests="${WATCH_REVIEW_REQUESTS:-0}"
watch_tasks="${WATCH_TASKS:-0}"
watch_poll_interval="${WATCH_POLL_INTERVAL:-300}"
watch_trigger_failure_backoff_secs="${WATCH_TRIGGER_FAILURE_BACKOFF_SECS:-300}"
task_poll_interval_secs="${TASK_POLL_INTERVAL_SECS:-120}"
task_heartbeat_interval_seconds="${AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS:-45}"
task_dispatch_agent_ids="${TASK_DISPATCH_AGENT_IDS:-}"
watch_messaging="${WATCH_MESSAGING:-0}"
messaging_agent_id="${MESSAGING_AGENT_ID:-}"
# shellcheck disable=SC2034  # used by triggers/messaging.sh
messaging_target_repo="${MESSAGING_TARGET_REPO:-}"
global_slot_timeout_messaging_secs="${GLOBAL_SLOT_TIMEOUT_MESSAGING_SECS:-600}"
orphan_recovery_grace_secs="${ORPHAN_RECOVERY_GRACE_SECS:-0}"
queue_artifact_ttl_secs="${QUEUE_ARTIFACT_TTL_SECS:-604800}"
workspace_ttl_secs="${WORKSPACE_TTL_SECS:-86400}"
queue_maintenance_interval_secs="${QUEUE_MAINTENANCE_INTERVAL_SECS:-60}"
heartbeat_interval_secs="${HEARTBEAT_INTERVAL_SECS:-1800}"
shutdown_grace_secs="${CONTROLLER_SHUTDOWN_GRACE_SECS:-30}"
global_slot_timeout_exit_code=124
workspace_root="${CONTROLLER_WORKSPACE_ROOT:-${WORKSPACE_ROOT:-$(pwd)/data/controller}}"
shutdown_flag_file="${workspace_root}/shutdown.requested"
jobs_root="${workspace_root}/jobs"
runs_root="${workspace_root}/runs"
workspaces_root="${workspace_root}/workspaces"
homes_root="${workspace_root}/homes"
queue_root="${workspace_root}/queue"
watch_state_root="${workspace_root}/watch-state"
messaging_homes_root="${workspace_root}/messaging-homes"
messaging_sessions_root="${workspace_root}/messaging-sessions"
memory_root="${workspace_root}/memory"
lock_dir="${CONTROLLER_LOCK_DIR:-/tmp/hivemoot-controller-locks}"
token_tmp_root="${CONTROLLER_TOKEN_TMP_ROOT:-/tmp/hivemoot-controller-token-files}"
global_extra_prompt="${AGENT_EXTRA_PROMPT:-}"
agent_timeout_seconds="${AGENT_TIMEOUT_SECONDS:-1800}"
target_repo="${TARGET_REPO:-}"
task_claim_url="${AGENT_TASK_CLAIM_URL:-}"
task_execute_base_url="${AGENT_TASK_EXECUTE_BASE_URL:-}"
task_executor_token=""
max_agents=10
controller_instance_id="$(date +%s)-$$"
shutdown_requested=0
completed_jobs=0
failed_jobs=0
last_queue_maintenance_epoch=0
next_task_agent_index=0
task_agent_count=0
claimed_task_id=""
claimed_task_prompt=""
claimed_task_repo=""
claimed_task_claim_token=""
claimed_task_messages_json=""
last_heartbeat_epoch=0
controller_trigger_prepared_extra_prompt=""
controller_trigger_prepared_session_key=""
controller_trigger_prepared_codex_answer_host_path=""
controller_trigger_prepared_codex_answer_worker_path=""
controller_trigger_background_pid=""
controller_trigger_prepared_job_home=""
controller_trigger_prepared_persistent_session_dir=""
controller_trigger_prepared_memory_host_dir=""
controller_trigger_prepared_memory_mode=""
controller_trigger_prepared_skip_credential_cleanup=0

declare -a temp_token_files=()
declare -a running_pids=()
declare -a watcher_pids=()
declare -a scheduler_pids=()
declare -a task_agent_ids=()
declare -A pid_to_job_id=()
declare -A pid_to_repo=()
declare -A pid_to_agent=()
declare -A pid_to_trigger_type=()
declare -A pid_to_ack_key=()
declare -A pid_to_state_file=()
declare -A pid_to_processing_file=()
declare -A agent_token_files=()
declare -A repo_lock_files=()

case "$controller_mode" in
  once|loop) ;;
  *)
    echo "Unsupported CONTROLLER_RUN_MODE: ${controller_mode}. Use once|loop." >&2
    exit 1
    ;;
esac

case "$watch_mentions" in
  0|1) ;;
  *)
    echo "WATCH_MENTIONS must be 0 or 1." >&2
    exit 1
    ;;
esac
case "$watch_review_requests" in
  0|1) ;;
  *)
    echo "WATCH_REVIEW_REQUESTS must be 0 or 1." >&2
    exit 1
    ;;
esac
case "$watch_tasks" in
  0|1) ;;
  *)
    echo "WATCH_TASKS must be 0 or 1." >&2
    exit 1
    ;;
esac

if [ "$watch_tasks" = "1" ] && { [ "$watch_mentions" = "1" ] || [ "$watch_review_requests" = "1" ]; }; then
  echo "WATCH_TASKS cannot be combined with WATCH_MENTIONS or WATCH_REVIEW_REQUESTS." >&2
  exit 1
fi

require_positive_integer CONTROLLER_MAX_WORKERS "$controller_max_workers"
require_non_negative_integer GLOBAL_MAX_WORKERS "$global_max_workers"
require_positive_integer AGENT_TIMEOUT_SECONDS "$agent_timeout_seconds"
require_positive_integer CONTROLLER_SHUTDOWN_GRACE_SECS "$shutdown_grace_secs"
require_non_negative_integer GLOBAL_SLOT_TIMEOUT_PERIODIC_SECS "$global_slot_timeout_periodic_secs"
require_non_negative_integer GLOBAL_SLOT_TIMEOUT_MENTION_SECS "$global_slot_timeout_mention_secs"
require_non_negative_integer GLOBAL_SLOT_TIMEOUT_TASK_SECS "$global_slot_timeout_task_secs"
require_positive_integer PERIODIC_INTERVAL_SECS "$periodic_interval"
require_non_negative_integer PERIODIC_JITTER_SECS "$periodic_jitter"
require_non_negative_integer ORPHAN_RECOVERY_GRACE_SECS "$orphan_recovery_grace_secs"
require_non_negative_integer QUEUE_ARTIFACT_TTL_SECS "$queue_artifact_ttl_secs"
require_non_negative_integer WORKSPACE_TTL_SECS "$workspace_ttl_secs"
require_non_negative_integer QUEUE_MAINTENANCE_INTERVAL_SECS "$queue_maintenance_interval_secs"
require_non_negative_integer HEARTBEAT_INTERVAL_SECS "$heartbeat_interval_secs"
require_non_negative_integer AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS "$task_heartbeat_interval_seconds"
require_non_negative_integer WATCH_TRIGGER_FAILURE_BACKOFF_SECS "$watch_trigger_failure_backoff_secs"
if [ "$watch_mentions" = "1" ] || [ "$watch_review_requests" = "1" ]; then
  require_positive_integer WATCH_POLL_INTERVAL "$watch_poll_interval"
fi

case "$workspace_root" in
  /*) ;;
  *)
    echo "CONTROLLER_WORKSPACE_ROOT must be an absolute path: ${workspace_root}" >&2
    exit 1
    ;;
esac

if [ "$watch_tasks" = "0" ]; then
  validate_target_repo "$target_repo"
fi

if [ "$watch_tasks" = "1" ]; then
  if ! task_executor_token="$(resolve_secret_value HIVEMOOT_AGENT_TOKEN)"; then
    exit 1
  fi
  if [ -z "$task_executor_token" ]; then
    echo "HIVEMOOT_AGENT_TOKEN or HIVEMOOT_AGENT_TOKEN_FILE is required when WATCH_TASKS=1." >&2
    exit 1
  fi
  if [ -z "$task_claim_url" ]; then
    echo "AGENT_TASK_CLAIM_URL is required when WATCH_TASKS=1." >&2
    exit 1
  fi
  if ! validate_url_scheme "$task_claim_url" "AGENT_TASK_CLAIM_URL"; then
    exit 1
  fi
  if [ -z "$task_execute_base_url" ]; then
    task_execute_base_url="${task_claim_url%/claim}"
  fi
  if ! validate_url_scheme "$task_execute_base_url" "AGENT_TASK_EXECUTE_BASE_URL"; then
    exit 1
  fi
fi

if ! command -v "$docker_cmd" >/dev/null 2>&1; then
  echo "Missing required command: ${docker_cmd}" >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "Missing required command: flock" >&2
  exit 1
fi
if [ "$watch_tasks" = "1" ]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "Missing required command when WATCH_TASKS=1: curl" >&2
    exit 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "Missing required command when WATCH_TASKS=1: jq" >&2
    exit 1
  fi
fi
if [ "$watch_mentions" = "1" ] || [ "$watch_review_requests" = "1" ]; then
  if ! command -v hivemoot >/dev/null 2>&1; then
    echo "Missing required command when GitHub watch triggers are enabled: hivemoot" >&2
    exit 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "Missing required command when GitHub watch triggers are enabled: jq" >&2
    exit 1
  fi
fi
if [ "$watch_messaging" = "1" ] && [ "$controller_mode" = "once" ]; then
  echo "WATCH_MESSAGING=1 requires CONTROLLER_RUN_MODE=loop (once mode has no poll loop)." >&2
  exit 1
fi
if [ "$watch_messaging" = "1" ] && [ "$watch_tasks" = "1" ]; then
  echo "WATCH_MESSAGING=1 and WATCH_TASKS=1 cannot be used together (task-watch returns before messaging starts)." >&2
  exit 1
fi
if [ "$watch_messaging" = "1" ]; then
  if [ -z "$messaging_agent_id" ]; then
    echo "MESSAGING_AGENT_ID is required when WATCH_MESSAGING=1" >&2
    exit 1
  fi
  # Credential + dependency validation is delegated to the Python CLI;
  # it surfaces actionable errors on stderr and exits non-zero so the
  # controller fails to start rather than silently polling a broken
  # adapter.
  if ! hivemoot-agent messaging preflight \
       --platform "${MESSAGING_PLATFORM:-telegram}"; then
    exit 1
  fi
fi

mkdir -p "$jobs_root" "$runs_root" "$workspaces_root" "$homes_root" "$queue_root" "$watch_state_root" "$lock_dir" "$token_tmp_root" "$messaging_homes_root" "$messaging_sessions_root" "$memory_root"
chmod 700 "$workspace_root" "$jobs_root" "$runs_root" "$workspaces_root" "$homes_root" "$queue_root" "$watch_state_root" "$lock_dir" "$token_tmp_root" "$messaging_homes_root" "$messaging_sessions_root" "$memory_root" 2>/dev/null || true
rm -f "$shutdown_flag_file"
init_global_slots "$global_slots_dir" "$global_max_workers"
declare -A seen_agents=()
declare -A agent_skill_lists=()
declare -a agent_ids=()
declare -a agent_tokens=()
load_agent_slots "$max_agents"

for index in "${!agent_ids[@]}"; do
  aid="${agent_ids[$index]}"
  token_value="${agent_tokens[$index]}"
  token_file="$(mktemp "${token_tmp_root}/${aid}.XXXXXX")"
  printf '%s' "$token_value" > "$token_file"
  chmod 600 "$token_file" 2>/dev/null || true
  if [[ "$(uname -s)" == "Linux" ]]; then
    chown 1000:1000 "$token_file" 2>/dev/null || true
  fi
  temp_token_files+=("$token_file")
  agent_token_files["$aid"]="$token_file"
  if [ -n "$target_repo" ]; then
    ensure_agent_lock_file "$target_repo" "$aid"
  fi
done

if [ "$watch_tasks" = "1" ]; then
  load_task_dispatch_agent_scope "$task_dispatch_agent_ids"
fi
if [ "$watch_messaging" = "1" ] && [ -z "${agent_token_files[$messaging_agent_id]:-}" ]; then
  echo "MESSAGING_AGENT_ID '${messaging_agent_id}' is not a configured agent slot." >&2
  exit 1
fi

for slot in $(seq 1 "$max_agents"); do
  suffix="$(printf '%02d' "$slot")"
  unset "AGENT_GITHUB_TOKEN_${suffix}" "AGENT_GITHUB_TOKEN_${suffix}_FILE" || true
done

trap handle_shutdown TERM INT
trap cleanup EXIT

agent_count="${#agent_ids[@]}"

log "Controller starting: mode=${controller_mode} repo=${target_repo} agents=${agent_count} max_workers=${controller_max_workers}"
if [ "${HIVEMOOT_GLOBAL_SLOTS_ENABLED:-0}" = "1" ]; then
  log "Global worker slots enabled: count=${global_max_workers} dir=${global_slots_dir}"
elif [ "$global_max_workers" -gt 0 ]; then
  log "Global worker slots disabled: count=${global_max_workers} dir=${global_slots_dir:-unset}"
fi
log "Worker image: ${worker_image}"
log "Workspace root: ${workspace_root}"
log "This controller runs on the host. Do not mount docker.sock into a container for controller execution."
if [ "$watch_tasks" = "1" ]; then
  log "Task watching enabled (claim URL: ${task_claim_url}, poll interval: ${task_poll_interval_secs}s)"
  log "Task dispatch scope: ${task_dispatch_agent_ids}"
else
  if [ "$watch_mentions" = "1" ]; then
    log "Mention watching enabled (poll interval: ${watch_poll_interval}s)"
  else
    log "Mention watching disabled"
  fi
  if [ "$watch_review_requests" = "1" ]; then
    log "Review-request watching enabled (poll interval: ${watch_poll_interval}s)"
  else
    log "Review-request watching disabled"
  fi
  if [ "$watch_messaging" = "1" ]; then
    log "Messaging enabled (platform=${MESSAGING_PLATFORM:-telegram}, agent=${messaging_agent_id})"
  fi
fi

if [ "$controller_mode" = "loop" ]; then
  run_loop_mode
else
  run_once_mode
fi

wait_for_all_jobs

if [ "$failed_jobs" -gt 0 ]; then
  log "Controller finished with failures: completed=${completed_jobs} failed=${failed_jobs}"
  exit 1
fi

log "Controller finished successfully: completed=${completed_jobs} failed=${failed_jobs}"
