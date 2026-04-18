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
# shellcheck source=controller/triggers/periodic.sh
. "${TRIGGER_DIR}/periodic.sh"

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
periodic_interval="${PERIODIC_INTERVAL_SECS:-3600}"
periodic_jitter="${PERIODIC_JITTER_SECS:-300}"
orphan_recovery_grace_secs="${ORPHAN_RECOVERY_GRACE_SECS:-0}"
queue_artifact_ttl_secs="${QUEUE_ARTIFACT_TTL_SECS:-604800}"
workspace_ttl_secs="${WORKSPACE_TTL_SECS:-86400}"
queue_maintenance_interval_secs="${QUEUE_MAINTENANCE_INTERVAL_SECS:-60}"
shutdown_grace_secs="${CONTROLLER_SHUTDOWN_GRACE_SECS:-30}"
global_slot_timeout_exit_code=124
workspace_root="${CONTROLLER_WORKSPACE_ROOT:-${WORKSPACE_ROOT:-$(pwd)/data/controller}}"
shutdown_flag_file="${workspace_root}/shutdown.requested"
jobs_root="${workspace_root}/jobs"
runs_root="${workspace_root}/runs"
workspaces_root="${workspace_root}/workspaces"
homes_root="${workspace_root}/homes"
queue_root="${workspace_root}/queue"
memory_root="${workspace_root}/memory"
lock_dir="${CONTROLLER_LOCK_DIR:-/tmp/hivemoot-controller-locks}"
token_tmp_root="${CONTROLLER_TOKEN_TMP_ROOT:-/tmp/hivemoot-controller-token-files}"
global_extra_prompt="${AGENT_EXTRA_PROMPT:-}"
agent_timeout_seconds="${AGENT_TIMEOUT_SECONDS:-1800}"
target_repo="${TARGET_REPO:-}"
max_agents=10
controller_instance_id="$(date +%s)-$$"
shutdown_requested=0
completed_jobs=0
failed_jobs=0
last_queue_maintenance_epoch=0

declare -a temp_token_files=()
declare -a running_pids=()
declare -a scheduler_pids=()
declare -A pid_to_job_id=()
declare -A pid_to_repo=()
declare -A pid_to_agent=()
declare -A pid_to_trigger_type=()
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

require_positive_integer CONTROLLER_MAX_WORKERS "$controller_max_workers"
require_non_negative_integer GLOBAL_MAX_WORKERS "$global_max_workers"
require_positive_integer AGENT_TIMEOUT_SECONDS "$agent_timeout_seconds"
require_positive_integer CONTROLLER_SHUTDOWN_GRACE_SECS "$shutdown_grace_secs"
require_non_negative_integer GLOBAL_SLOT_TIMEOUT_PERIODIC_SECS "$global_slot_timeout_periodic_secs"
require_positive_integer PERIODIC_INTERVAL_SECS "$periodic_interval"
require_non_negative_integer PERIODIC_JITTER_SECS "$periodic_jitter"
require_non_negative_integer ORPHAN_RECOVERY_GRACE_SECS "$orphan_recovery_grace_secs"
require_non_negative_integer QUEUE_ARTIFACT_TTL_SECS "$queue_artifact_ttl_secs"
require_non_negative_integer WORKSPACE_TTL_SECS "$workspace_ttl_secs"
require_non_negative_integer QUEUE_MAINTENANCE_INTERVAL_SECS "$queue_maintenance_interval_secs"

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
if ! command -v jq >/dev/null 2>&1; then
  echo "Missing required command: jq" >&2
  exit 1
fi
mkdir -p "$jobs_root" "$runs_root" "$workspaces_root" "$homes_root" "$queue_root" "$lock_dir" "$token_tmp_root" "$memory_root"
chmod 700 "$workspace_root" "$jobs_root" "$runs_root" "$workspaces_root" "$homes_root" "$queue_root" "$lock_dir" "$token_tmp_root" "$memory_root" 2>/dev/null || true
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
