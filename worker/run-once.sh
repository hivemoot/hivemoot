#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[run-once %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

_cleanup_files=()
_cleanup_dirs=()
# shellcheck disable=SC2317,SC2329  # invoked via trap
cleanup_once() {
  for f in "${_cleanup_files[@]-}"; do
    rm -f "$f" 2>/dev/null || true
  done
  for d in "${_cleanup_dirs[@]-}"; do
    rm -rf "$d" 2>/dev/null || true
  done
}
trap cleanup_once EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SHARED_DIR="${SHARED_DIR:-${REPO_ROOT}/shared}"

# shellcheck source=shared/lib.sh
. "${SHARED_DIR}/lib.sh"

# ── Plugins ───────────────────────────────────────────────────────
load_identity_plugin
load_workload_plugin
# shellcheck source=shared/lib-observability.sh
. "${SHARED_DIR}/lib-observability.sh"

load_secret_from_file AGENT_GITHUB_TOKEN
load_secret_from_file HIVEMOOT_AGENT_TOKEN
load_provider_secrets

# shellcheck source=shared/opencode-helpers.sh
. "${SHARED_DIR}/opencode-helpers.sh"
# shellcheck source=shared/token-extractor.sh
. "${SHARED_DIR}/token-extractor.sh"

is_valid_uuid() {
  local value="$1"
  printf '%s' "$value" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

is_non_negative_integer() {
  local value="${1:-}"
  printf '%s' "$value" | grep -Eq '^[0-9]+$'
}

is_positive_integer() {
  local value="${1:-}"
  printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'
}

load_session_record_for_key() {
  local map_file="$1"
  local session_key="$2"

  if [ ! -f "$map_file" ] || [ -z "$session_key" ]; then
    return 0
  fi

  awk -F '\t' -v key="$session_key" '
    $1 == key {
      sid = $2
      created = $3
      last_used = $4
    }
    END {
      if (sid != "") {
        print sid "\t" created "\t" last_used
      }
    }
  ' "$map_file"
}

save_session_record_for_key() {
  local map_file="$1"
  local session_key="$2"
  local session_id="$3"
  local created_epoch="${4:-}"
  local last_used_epoch="${5:-}"
  local map_dir=""
  local tmp_file=""
  local now_epoch=""

  if [ -z "$session_key" ] || [ -z "$session_id" ]; then
    return 0
  fi

  now_epoch="$(date +%s)"
  if ! is_non_negative_integer "$created_epoch"; then
    created_epoch="$now_epoch"
  fi
  if ! is_non_negative_integer "$last_used_epoch"; then
    last_used_epoch="$now_epoch"
  fi

  map_dir="$(dirname "$map_file")"
  mkdir -p "$map_dir"
  tmp_file="$(mktemp "${map_dir}/session-map.XXXXXX")"

  if [ -f "$map_file" ]; then
    awk -F '\t' -v key="$session_key" '$1 != key { print $0 }' "$map_file" > "$tmp_file"
  fi

  printf '%s\t%s\t%s\t%s\n' "$session_key" "$session_id" "$created_epoch" "$last_used_epoch" >> "$tmp_file"
  mv "$tmp_file" "$map_file"
  chmod 600 "$map_file" 2>/dev/null || true
}

extract_codex_session_id_from_log() {
  local path="$1"

  if [ ! -f "$path" ]; then
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    jq -Rr 'fromjson? | select(.type=="thread.started") | .thread_id // empty' "$path" | head -n 1
    return 0
  fi

  sed -nE 's/.*"type":"thread\.started".*"thread_id":"([0-9a-fA-F-]{36})".*/\1/p' "$path" | head -n 1
}

extract_claude_session_id_from_log() {
  local path="$1"

  if [ ! -f "$path" ]; then
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    jq -Rr 'fromjson? | select(.type=="system" and .subtype=="init") | .session_id // empty' "$path" | head -n 1
    return 0
  fi

  sed -nE 's/.*"type":"system".*"subtype":"init".*"session_id":"([0-9a-fA-F-]{36})".*/\1/p' "$path" | head -n 1
}

build_scoped_session_key() {
  local base_key="$1"
  local repo_full_name="$2"
  local provider_name="$3"
  local model_name="$4"
  local tool_options_json="$5"
  local options_hash=""
  local resolved_model=""

  if [ -z "$base_key" ]; then
    return 0
  fi

  options_hash="$(printf '%s' "$tool_options_json" | cksum | awk '{print $1}')"
  resolved_model="${model_name:-default}"

  printf 'repo=%s|provider=%s|model=%s|toolopts=%s|key=%s' \
    "$repo_full_name" "$provider_name" "$resolved_model" "$options_hash" "$base_key"
}

should_resume_session() {
  local created_epoch="$1"
  local last_used_epoch="$2"
  local now_epoch="$3"
  local max_idle_hours="$4"
  local max_age_hours="$5"
  local reset_hour="${6:-}"
  local idle_age=""
  local total_age=""

  if ! is_non_negative_integer "$created_epoch" \
    || ! is_non_negative_integer "$last_used_epoch" \
    || ! is_non_negative_integer "$now_epoch" \
    || ! is_positive_integer "$max_idle_hours" \
    || ! is_positive_integer "$max_age_hours"; then
    return 1
  fi

  idle_age=$((now_epoch - last_used_epoch))
  total_age=$((now_epoch - created_epoch))

  if [ "$idle_age" -lt 0 ] || [ "$total_age" -lt 0 ]; then
    return 1
  fi

  if [ "$idle_age" -gt $((max_idle_hours * 3600)) ]; then
    return 1
  fi

  if [ "$total_age" -gt $((max_age_hours * 3600)) ]; then
    return 1
  fi

  # Day-boundary reset: if configured, expire sessions that were created
  # before the most recent reset hour AND have been idle for at least 1h
  # (grace window prevents killing active late-night conversations).
  if [ -n "$reset_hour" ] && is_non_negative_integer "$reset_hour" \
    && [ "$reset_hour" -ge 0 ] && [ "$reset_hour" -le 23 ]; then
    local boundary_epoch=""
    boundary_epoch="$(_last_reset_boundary "$now_epoch" "$reset_hour")"
    if [ -n "$boundary_epoch" ] \
      && [ "$created_epoch" -lt "$boundary_epoch" ] \
      && [ "$idle_age" -ge 3600 ]; then
      return 1
    fi
  fi

  return 0
}

_last_reset_boundary() {
  # Compute the most recent occurrence of reset_hour as a Unix epoch.
  # Uses the system's local timezone (honoring TZ env var).
  local now_epoch="$1"
  local reset_hour="$2"

  # date -d is GNU, date -j -f is BSD.  Try GNU first, fall back to
  # a portable awk approach using localtime().
  local today_str=""
  today_str="$(date -d "@${now_epoch}" '+%Y-%m-%d' 2>/dev/null || date -r "$now_epoch" '+%Y-%m-%d' 2>/dev/null)" || return 1

  local boundary_epoch=""
  boundary_epoch="$(date -d "${today_str} ${reset_hour}:00:00" '+%s' 2>/dev/null || date -j -f '%Y-%m-%d %H:%M:%S' "${today_str} ${reset_hour}:00:00" '+%s' 2>/dev/null)" || return 1

  if [ "$now_epoch" -ge "$boundary_epoch" ]; then
    printf '%s' "$boundary_epoch"
  else
    # Haven't reached today's boundary yet — use yesterday's.
    printf '%s' $((boundary_epoch - 86400))
  fi
}

provider="${AGENT_PROVIDER:-claude}"
auth_mode="${AGENT_AUTH_MODE:-auto}"
# Default to "manual" for standalone invocations; controller injects the real value.
RUN_TRIGGER_TYPE="${RUN_TRIGGER_TYPE:-manual}"
# shellcheck disable=SC2034  # consumed by sourced workload plugins
hivemoot_buzz_role="${HIVEMOOT_BUZZ_ROLE:-}"
target_repo="${TARGET_REPO:-}"
workspace_root="${WORKSPACE_ROOT:-/workspace}"
clone_depth="${GIT_CLONE_DEPTH:-50}"
agent_skills="${AGENT_SKILLS:-}"
agent_available_skills="${AGENT_AVAILABLE_SKILLS:-}"
extra_prompt="${AGENT_EXTRA_PROMPT:-}"
extra_prompt_file="${AGENT_EXTRA_PROMPT_FILE:-}"
agent_model="${AGENT_MODEL:-}"
agent_tool_options_json="${AGENT_TOOL_OPTIONS_JSON:-"{}"}"
timeout_secs="${AGENT_TIMEOUT_SECONDS:-1800}"
session_resume="${SESSION_RESUME:-${SESSION_RESUME_ENABLED:-1}}"
session_resume_max_idle_hours="${SESSION_RESUME_MAX_IDLE_HOURS:-12}"
session_resume_max_age_hours="${SESSION_RESUME_MAX_AGE_HOURS:-24}"
session_reset_at_hour="${SESSION_RESET_AT_HOUR:-}"


agent_session_key="${AGENT_SESSION_KEY:-}"
resume_staleness_note="You are resuming a prior session for this work item. Some data in your context may be stale; refresh the relevant information before acting."
effective_auth_mode=""

case "$session_resume" in
  0|1) ;;
  *)
    echo "Unsupported SESSION_RESUME: ${session_resume}. Use 0|1." >&2
    exit 1
    ;;
esac

if ! is_positive_integer "$session_resume_max_idle_hours"; then
  echo "Unsupported SESSION_RESUME_MAX_IDLE_HOURS: ${session_resume_max_idle_hours}. Use a positive integer." >&2
  exit 1
fi

if ! is_positive_integer "$session_resume_max_age_hours"; then
  echo "Unsupported SESSION_RESUME_MAX_AGE_HOURS: ${session_resume_max_age_hours}. Use a positive integer." >&2
  exit 1
fi

if ! is_non_negative_integer "$clone_depth"; then
  echo "Unsupported GIT_CLONE_DEPTH: ${clone_depth}. Use 0 (full clone) or a positive integer." >&2
  exit 1
fi

if [ -n "$extra_prompt_file" ]; then
  if [ ! -f "$extra_prompt_file" ]; then
    echo "AGENT_EXTRA_PROMPT_FILE not found: ${extra_prompt_file}" >&2
    exit 1
  fi
  if [ -n "$extra_prompt" ]; then
    extra_prompt="${extra_prompt}

$(cat "$extra_prompt_file")"
  else
    extra_prompt="$(cat "$extra_prompt_file")"
  fi
fi

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

validate_workspace_root "$workspace_root"

# When REPO_DIR/LOG_DIR are set externally (run-loop.sh or the controller),
# isolation is handled by the caller. Otherwise, generate a JOB_ID to
# namespace workspace/HOME/logs so every standalone run is isolated.
managed_mode=0
if [ -n "${REPO_DIR:-}" ] || [ -n "${LOG_DIR:-}" ]; then
  managed_mode=1
fi

job_id="${JOB_ID:-}"
if [ -n "$job_id" ]; then
  validate_job_id "$job_id"
fi
if [ -z "$job_id" ] && [ "$managed_mode" -eq 0 ]; then
  job_id="$(date '+%Y%m%d-%H%M%S')-$$"
fi

if [ -n "$job_id" ] && [ "$managed_mode" -eq 0 ]; then
  repo_dir="${workspace_root}/${job_id}/repo"
  log_dir="${workspace_root}/${job_id}/runs"
  job_home="$(resolve_job_home "$workspace_root" "$job_id" "$effective_auth_mode")"
  log "Job isolation: JOB_ID=${job_id}"
else
  repo_dir="${REPO_DIR:-${workspace_root}/repo}"
  log_dir="${LOG_DIR:-${workspace_root}/runs}"
  job_home=""
fi

session_resume_key="$(build_scoped_session_key "$agent_session_key" "$target_repo" "$provider" "$agent_model" "$agent_tool_options_json")"
# Use a persistent session-map directory when the controller provides one
# (messaging triggers).  Otherwise fall back to the per-job workspace.
if [ -n "${PERSISTENT_SESSION_DIR:-}" ] && [ -d "$PERSISTENT_SESSION_DIR" ]; then
  provider_session_map_dir="${PERSISTENT_SESSION_DIR}/sessions/${provider}"
else
  provider_session_map_dir="${workspace_root}/sessions/${provider}"
fi
provider_session_map_file="${provider_session_map_dir}/tool-session-map.tsv"

# ── Identity ──────────────────────────────────────────────────────
identity_resolve
# shellcheck disable=SC2154  # agent_name is populated by the sourced identity plugin
log "Identity: ${AGENT_IDENTITY:-unknown} agent_name=${agent_name}"

# ── Workload Setup ────────────────────────────────────────────────
workload_setup

mkdir -p "$workspace_root" "$log_dir"

# Create an isolated HOME for this job and seed only auth credentials
# (not conversation caches or session state). Skipped in managed mode
# where the caller (run-loop.sh / controller) handles HOME isolation.
if [ -n "$job_home" ]; then
  mkdir -p "$job_home/.config" "$job_home/.cache" "$job_home/.local/share"
  chmod 700 "$job_home" "$job_home/.config" "$job_home/.cache" \
    "$job_home/.local" "$job_home/.local/share" 2>/dev/null || true

  # Seed only auth credentials into the isolated job home; skip session
  # state (conversation caches, memory, etc.).
  seed_provider_auth "$job_home" "$HOME"

  # Carry forward .profile so agent subprocesses find npm binaries.
  if [ -f "${HOME}/.profile" ]; then
    cp "${HOME}/.profile" "$job_home/.profile"
  fi

  export HOME="$job_home"
  log "Job HOME set to: ${job_home}"
fi

inject_agent_memory() {
  # AGENT_MEMORY_MODE controls what gets injected into the system prompt:
  #   rw   — inject memory content + write protocol (agent reads and writes)
  #   ro   — inject memory content only (agent reads, no write instructions)
  #   none — skip entirely (no memory in the prompt)
  local mode="${AGENT_MEMORY_MODE:-rw}"
  if [ "$mode" = "none" ]; then
    return 0
  fi

  local memory_file="${AGENT_MEMORY_DIR:-/home/node/.hivemoot/memory}/MEMORY.md"
  local has_memory=0
  if [ -f "$memory_file" ] && [ -s "$memory_file" ]; then
    has_memory=1
  fi

  # Nothing to inject: no existing memory and no write protocol to add.
  if [ "$has_memory" -eq 0 ] && [ "$mode" != "rw" ]; then
    return 0
  fi

  printf '\n\n'

  # Inject existing memory content.
  if [ "$has_memory" -eq 1 ]; then
    # Strip closing tag to prevent prompt injection via poisoned memory files.
    local sanitized=""
    sanitized="$(sed 's|</agent-memory>||g' "$memory_file")"
    printf '<agent-memory>\n'
    printf 'These are notes you wrote in prior runs. Use them to build on prior work.\n'
    printf 'If anything conflicts with current repo state, trust the repo and update your memory.\n\n'
    printf '%s' "$sanitized"
    printf '\n</agent-memory>\n'
  fi

  # Inject write protocol only in read-write mode.
  if [ "$mode" = "rw" ]; then
    cat <<'MEMORY_PROTOCOL'

## Memory Protocol
You have persistent memory at `~/.hivemoot/memory/MEMORY.md` that survives across runs.

**Reading memory**: Your memory (if any) is included above in `<agent-memory>` tags. Use it to avoid rediscovering things you already know and to continue incomplete work.

**Writing memory**: Update `~/.hivemoot/memory/MEMORY.md` when you:
- Discover architectural patterns or code conventions
- Make or observe a significant decision (with rationale)
- Encounter a gotcha or non-obvious behavior
- Complete work that future runs should know about
- Identify work that needs follow-up in a future run

**Before finishing**: Review and update your memory file. Remove stale entries (merged PRs, resolved issues, outdated facts). Add what you learned this run.

**Format**:
```md
# Agent Memory — {your-role}/{repo}

## Architecture
- [YYYY-MM-DD] Key structural facts about the codebase

## Decisions
- [YYYY-MM-DD] Significant decisions with rationale

## Patterns
- Recurring patterns, conventions, and anti-patterns

## Gotchas
- [YYYY-MM-DD] Non-obvious behaviors, traps, edge cases

## Progress
- [YYYY-MM-DD] Current state of ongoing work

## Next Run
- Concrete actions for the next run to pick up
```

**Size limit**: Keep under ~200 lines. Consolidate related entries. Remove outdated information. Quality over quantity — save what a future version of you actually needs.
MEMORY_PROTOCOL
  fi
}

# Per-job cleanup: remove transient state on exit when JOB_ID is set.
# Registered early (before clone_repo) so that any failure between the
# HOME redirect and provider launch still gets cleaned up.
# shellcheck disable=SC2317,SC2329  # invoked via trap
cleanup_job() {
  if [ -z "$job_home" ]; then
    return 0
  fi
  log "Cleaning up job state: JOB_ID=${job_id}"
  # Remove the entire job-scoped directory (repo, logs, HOME).
  # This prevents accumulation when JOB_ID is auto-generated for standalone runs.
  local job_root="${workspace_root}/${job_id}"
  local persistent_job_home="${job_root}/home"
  if [ -d "$job_root" ]; then
    rm -rf "$job_root"
  fi
  if [ "$job_home" != "$persistent_job_home" ] && [ -d "$job_home" ]; then
    rm -rf "$job_home"
  fi
  # Remove job-scoped tmp files
  if [ -n "$job_id" ]; then
    rm -f "/tmp/hivemoot-agent-${job_id}"* 2>/dev/null || true
  fi
}
trap cleanup_job EXIT

# ── Prompt Assembly ───────────────────────────────────────────────
# identity_prompt → WHO (soul, guardrails, role)
# workload_build_prompt → WHAT (work instructions, context)
# skills → HOW (capabilities)
identity_block="$(identity_prompt)"

if [ -n "${AGENT_PROMPT_FILE:-}" ] && [ -f "${AGENT_PROMPT_FILE}" ]; then
  workload_block="$(cat "$AGENT_PROMPT_FILE")"
else
  workload_block="$(workload_build_prompt)"
fi

memory_block="$(inject_agent_memory)"

system_prompt="${identity_block}

${workload_block}${memory_block}"

if [ -n "$agent_skills" ]; then
  skills_dir="$(workload_skills_dir)"
  skills_content=""
  if ! skills_content="$(load_skill_prompts "$agent_skills" "$skills_dir")"; then
    exit 1
  fi
  if [ -n "$skills_content" ]; then
    system_prompt="${system_prompt}

<skills>
${skills_content}
</skills>"
  fi
fi

if [ -n "$extra_prompt" ]; then
  user_message="$extra_prompt"
else
  user_message="$(workload_user_message)"
fi

# Combined prompt for providers that don't support separate system/user split.
prompt="${system_prompt}

${user_message}"

safe_agent_name="$(printf '%s' "$agent_name" | tr -c '[:alnum:]._-' '_')"
run_id="$(date '+%Y%m%d-%H%M%S')-${provider}-${safe_agent_name}"
log_file="${log_dir}/${run_id}.log"
events_file="${log_dir}/${run_id}.events.jsonl"
health_file="${log_dir}/health.json"
_event_seq=0
run_start_epoch="$(date +%s)"

cmd=()
run_in_repo=0
codex_active_session_id=""
codex_active_session_created_epoch=""
codex_used_resume=0
codex_fresh_cmd=()
codex_resume_supported=0
claude_active_session_id=""
claude_active_session_created_epoch=""
claude_used_resume=0
claude_fresh_cmd=()
claude_resume_supported=0
case "$provider" in
  codex)
    if ! command -v codex >/dev/null 2>&1; then
      echo "codex CLI is not installed in the container." >&2
      exit 1
    fi
    codex_auth_mode="$auth_mode"
    if [ "$codex_auth_mode" = "auto" ]; then
      if [ -n "${OPENAI_API_KEY:-}" ]; then
        codex_auth_mode="api_key"
      else
        codex_auth_mode="subscription"
      fi
    fi

    if [ "$codex_auth_mode" = "api_key" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "OPENAI_API_KEY is required when AGENT_PROVIDER=codex and AGENT_AUTH_MODE=api_key." >&2
      exit 1
    fi
    log "Codex auth mode resolved to: ${codex_auth_mode}"

    if [ "$codex_auth_mode" = "subscription" ]; then
      if ! codex login status >/dev/null 2>&1; then
        echo "Codex subscription login not found. Run with local override: docker compose -f docker-compose.yml -f docker-compose.subscription.local.yml run --rm auth-codex" >&2
        exit 1
      fi
    fi

    codex_reasoning_effort=""
    if [ "$agent_tool_options_json" != "{}" ]; then
      if ! command -v jq >/dev/null 2>&1; then
        echo "AGENT_TOOL_OPTIONS_JSON is set but jq is not installed." >&2
        exit 1
      fi
      jq_parse_stderr_file="$(mktemp)"
      if ! codex_reasoning_effort="$(printf '%s' "$agent_tool_options_json" | jq -r '.model_reasoning_effort // empty' 2>"$jq_parse_stderr_file")"; then
        jq_parse_error="$(tr '\n' ' ' <"$jq_parse_stderr_file" | sed -e 's/[[:space:]]\+/ /g' -e 's/^ //' -e 's/ $//')"
        rm -f "$jq_parse_stderr_file"
        if [ -n "$jq_parse_error" ]; then
          echo "Invalid AGENT_TOOL_OPTIONS_JSON: ${jq_parse_error}" >&2
        else
          echo "Invalid AGENT_TOOL_OPTIONS_JSON: failed to parse JSON payload." >&2
        fi
        exit 1
      fi
      rm -f "$jq_parse_stderr_file"
      case "$codex_reasoning_effort" in
        ""|low|medium|high|xhigh) ;;
        extra_high|extra-high)
          codex_reasoning_effort="xhigh"
          ;;
        *)
          echo "Invalid codex model_reasoning_effort: ${codex_reasoning_effort} (expected low|medium|high|xhigh)." >&2
          exit 1
          ;;
      esac
    fi

    codex_cmd_common=(--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json)
    if [ -n "$agent_model" ]; then
      codex_cmd_common+=(--model "$agent_model")
    fi
    if [ -n "$codex_reasoning_effort" ]; then
      codex_cmd_common+=(--config "model_reasoning_effort=\"${codex_reasoning_effort}\"")
      log "Codex reasoning effort: ${codex_reasoning_effort}"
    fi
    # In task mode, request a native answer sidecar via --output-last-message.
    # run-task.sh sets CODEX_ANSWER_FILE to the expected path before invoking
    # this script. The sidecar is written atomically at turn end and is more
    # reliable than JSONL log parsing.
    if [ -n "${CODEX_ANSWER_FILE:-}" ]; then
      mkdir -p "$(dirname "$CODEX_ANSWER_FILE")"
      codex_cmd_common+=(--output-last-message "$CODEX_ANSWER_FILE")
      log "Codex output-last-message: ${CODEX_ANSWER_FILE}"
    fi
    codex_fresh_cmd=(codex exec "${codex_cmd_common[@]}" "$prompt")

    if [ "$session_resume" = "1" ] && [ -n "$session_resume_key" ]; then
      # Probe resume support defensively: some CLI builds may expose
      # `resume` but handle `resume --help` inconsistently.
      if codex exec resume --help >/dev/null 2>&1 \
        || codex exec --help 2>&1 | grep -Eq '(^|[[:space:]])resume([[:space:]]|$)'; then
        codex_resume_supported=1
      else
        log "Codex resume unavailable; starting fresh session for key=${agent_session_key}"
      fi
    elif [ "$session_resume" = "0" ] && [ -n "$session_resume_key" ]; then
      log "Codex session resume disabled (SESSION_RESUME=0); starting fresh session for key=${agent_session_key}"
    fi

    codex_resume_now_epoch="$(date +%s)"
    if [ "$codex_resume_supported" -eq 1 ]; then
      codex_session_record="$(load_session_record_for_key "$provider_session_map_file" "$session_resume_key")"
      if [ -n "$codex_session_record" ]; then
        IFS=$'\t' read -r codex_record_session_id codex_record_created_epoch codex_record_last_used_epoch <<< "$codex_session_record"
      else
        codex_record_session_id=""
        codex_record_created_epoch=""
        codex_record_last_used_epoch=""
      fi

      if [ -n "$codex_record_session_id" ] && ! is_valid_uuid "$codex_record_session_id"; then
        log "Codex session resume: ignoring invalid session id for key=${agent_session_key}"
        codex_active_session_id=""
      elif [ -n "$codex_record_session_id" ] && ! should_resume_session \
        "$codex_record_created_epoch" "$codex_record_last_used_epoch" "$codex_resume_now_epoch" \
        "$session_resume_max_idle_hours" "$session_resume_max_age_hours" "$session_reset_at_hour"; then
        log "Codex session resume: policy reset for key=${agent_session_key} (max_idle=${session_resume_max_idle_hours}h max_age=${session_resume_max_age_hours}h)"
        codex_active_session_id=""
      else
        codex_active_session_id="$codex_record_session_id"
        codex_active_session_created_epoch="$codex_record_created_epoch"
      fi
    fi

    if [ -n "$codex_active_session_id" ]; then
      codex_used_resume=1
      log "Codex session resume: key=${agent_session_key} session=${codex_active_session_id}"
      prompt="${prompt}

${resume_staleness_note}"
      cmd=(codex exec resume "${codex_cmd_common[@]}" "$codex_active_session_id" "$prompt")
    else
      if [ -n "$session_resume_key" ] && [ "$codex_resume_supported" -eq 1 ]; then
        log "Codex session resume: no saved session for key=${agent_session_key}; starting fresh"
      fi
      cmd=("${codex_fresh_cmd[@]}")
    fi
    run_in_repo=1
    ;;

  gemini)
    if ! command -v gemini >/dev/null 2>&1; then
      echo "gemini CLI is not installed in the container." >&2
      exit 1
    fi
    gemini_auth_mode="$auth_mode"
    if [ "$gemini_auth_mode" = "auto" ]; then
      if [ -n "${GOOGLE_API_KEY:-}" ] || [ -n "${GEMINI_API_KEY:-}" ]; then
        gemini_auth_mode="api_key"
      else
        gemini_auth_mode="subscription"
      fi
    fi

    if [ "$gemini_auth_mode" = "api_key" ]; then
      if [ -z "${GOOGLE_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "GOOGLE_API_KEY (or GEMINI_API_KEY) is required when AGENT_PROVIDER=gemini and AGENT_AUTH_MODE=api_key." >&2
        exit 1
      fi
      if [ -z "${GOOGLE_API_KEY:-}" ] && [ -n "${GEMINI_API_KEY:-}" ]; then
        export GOOGLE_API_KEY="$GEMINI_API_KEY"
      fi
    else
      log "Using Gemini subscription/cached auth (no API key required)"
    fi
    log "Gemini auth mode resolved to: ${gemini_auth_mode}"

    # In task mode, use text output format so the log IS the answer text and
    # no log parsing is required. Keep stream-json for non-task runs where
    # structured events are useful for telemetry and session diagnostics.
    if [ -n "${AGENT_TASK_ID:-}" ]; then
      cmd=(gemini --yolo --output-format text -p "$prompt")
    else
      cmd=(gemini --yolo --output-format stream-json -p "$prompt")
    fi
    if [ -n "$agent_model" ]; then
      cmd+=(-m "$agent_model")
    fi
    run_in_repo=1
    ;;

  claude)
    if ! command -v claude >/dev/null 2>&1; then
      echo "claude CLI is not installed in the container." >&2
      exit 1
    fi
    claude_auth_mode="$auth_mode"
    if [ "$claude_auth_mode" = "auto" ]; then
      if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        claude_auth_mode="api_key"
      else
        claude_auth_mode="subscription"
      fi
    fi

    if [ "$claude_auth_mode" = "api_key" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
      echo "ANTHROPIC_API_KEY is required when AGENT_PROVIDER=claude and AGENT_AUTH_MODE=api_key." >&2
      exit 1
    fi

    if [ "$claude_auth_mode" = "subscription" ]; then
      if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
        log "Using Claude long-lived OAuth token"
      elif [ ! -d "${HOME}/.claude" ] && [ ! -d "${HOME}/.config/claude" ]; then
        echo "Claude subscription credentials not found. Run with local override: docker compose -f docker-compose.yml -f docker-compose.subscription.local.yml run --rm auth-claude" >&2
        echo "Or bootstrap with token: docker compose -f docker-compose.yml -f docker-compose.subscription.local.yml run --rm auth-claude-token" >&2
        exit 1
      else
        log "Using Claude subscription/cached auth (no API key required)"
      fi
    fi
    log "Claude auth mode resolved to: ${claude_auth_mode}"

    # Deny rules are enforced even with --dangerously-skip-permissions;
    # they block naive single-command exfiltration patterns from prompt injection.
    # See issue #94 for analysis and rationale.
    # Note: Bash(*) access means sufficiently creative shell invocations
    # (e.g. bash -c 'env', python3 -c 'import os; print(os.environ)') cannot
    # be blocked by deny lists alone — container isolation is the primary defense.
    claude_disallowed_tools=(
      "Bash(env)"
      "Bash(env *)"
      "Bash(printenv)"
      "Bash(printenv *)"
      "Bash(set)"
      "Bash(set *)"
      "Bash(export)"
      "Bash(export *)"
      "Bash(declare)"
      "Bash(declare *)"
      "Bash(cat /run/secrets/*)"
      "Bash(* /run/secrets/*)"
      "Read(/run/secrets/*)"
      # /proc/*/environ contains the full process environment as null-separated
      # KEY=VALUE pairs — reading it bypasses all shell-builtin deny rules above.
      # Glob covers /proc/self/environ, /proc/1/environ, and arbitrary PID paths.
      # Linux-specific; consistent with the /run/secrets/* entries above.
      "Bash(cat /proc/*/environ)"
      "Bash(* /proc/*/environ)"
      "Read(/proc/*/environ)"
    )

    # Available skills: Claude-only on-demand plugin dispatch.
    # AGENT_SKILLS are always injected via --append-system-prompt (V1 path above).
    # AGENT_AVAILABLE_SKILLS loads additional skills as native plugins via --plugin-dir
    # so the agent can discover and invoke them on demand.
    # Requires Claude CLI with --plugin-dir support. No fallback — if the flag is
    # unsupported, the run fails immediately rather than silently dropping skills.
    claude_plugin_dir=""
    if [ -n "$agent_available_skills" ]; then
      if ! claude --help 2>&1 | grep -q -- '--plugin-dir'; then
        echo "AGENT_AVAILABLE_SKILLS is set but the installed Claude CLI does not support --plugin-dir." >&2
        echo "Update CLAUDE_CODE_VERSION to a release that supports --plugin-dir, or unset AGENT_AVAILABLE_SKILLS." >&2
        exit 1
      fi
      if ! claude_plugin_dir="$(generate_claude_plugin_dir "$agent_available_skills" "$(workload_skills_dir)")"; then
        exit 1
      fi
      _cleanup_dirs+=("$claude_plugin_dir")
      log "Claude available skills: plugin-dir (${claude_plugin_dir})"
    fi

    # Keep stream-json in task mode so Claude session ids are still captured.
    # run-task.sh extracts the final result event back into markdown for task
    # consumers, while non-task runs keep verbose stream-json for telemetry.
    if [ -n "${AGENT_TASK_ID:-}" ]; then
      claude_fresh_cmd=(claude -p --output-format stream-json --dangerously-skip-permissions)
    else
      claude_fresh_cmd=(claude -p --verbose --output-format stream-json --dangerously-skip-permissions)
    fi
    claude_fresh_cmd+=(--disallowedTools "${claude_disallowed_tools[@]}")
    claude_fresh_cmd+=(--append-system-prompt "$system_prompt")
    if [ -n "$agent_model" ]; then
      claude_fresh_cmd+=(--model "$agent_model")
    fi
    if [ -n "$claude_plugin_dir" ]; then
      claude_fresh_cmd+=(--plugin-dir "$claude_plugin_dir")
    fi
    # Explicit end-of-flags separator: --plugin-dir (and --disallowedTools)
    # are variadic in some CLI versions, so without "--" they consume the
    # prompt as an extra directory/tool argument.
    claude_fresh_cmd+=("--" "$user_message")

    if [ "$session_resume" = "1" ] && [ -n "$session_resume_key" ]; then
      if claude -p --resume --help >/dev/null 2>&1 \
        || claude --help 2>&1 | grep -Eq '(^|[[:space:]])--resume([[:space:]]|$)'; then
        claude_resume_supported=1
      else
        log "Claude resume unavailable; starting fresh session for key=${agent_session_key}"
      fi
    elif [ "$session_resume" = "0" ] && [ -n "$session_resume_key" ]; then
      log "Claude session resume disabled (SESSION_RESUME=0); starting fresh session for key=${agent_session_key}"
    fi

    claude_resume_now_epoch="$(date +%s)"
    if [ "$claude_resume_supported" -eq 1 ]; then
      claude_session_record="$(load_session_record_for_key "$provider_session_map_file" "$session_resume_key")"
      if [ -n "$claude_session_record" ]; then
        IFS=$'\t' read -r claude_record_session_id claude_record_created_epoch claude_record_last_used_epoch <<< "$claude_session_record"
      else
        claude_record_session_id=""
        claude_record_created_epoch=""
        claude_record_last_used_epoch=""
      fi

      if [ -n "$claude_record_session_id" ] && ! is_valid_uuid "$claude_record_session_id"; then
        log "Claude session resume: ignoring invalid session id for key=${agent_session_key}"
        claude_active_session_id=""
      elif [ -n "$claude_record_session_id" ] && ! should_resume_session \
        "$claude_record_created_epoch" "$claude_record_last_used_epoch" "$claude_resume_now_epoch" \
        "$session_resume_max_idle_hours" "$session_resume_max_age_hours" "$session_reset_at_hour"; then
        log "Claude session resume: policy reset for key=${agent_session_key} (max_idle=${session_resume_max_idle_hours}h max_age=${session_resume_max_age_hours}h)"
        claude_active_session_id=""
      else
        claude_active_session_id="$claude_record_session_id"
        claude_active_session_created_epoch="$claude_record_created_epoch"
      fi
    fi

    if [ -n "$claude_active_session_id" ]; then
      claude_used_resume=1
      log "Claude session resume: key=${agent_session_key} session=${claude_active_session_id}"
      claude_resume_user_message="${user_message}

${resume_staleness_note}"
      if [ -n "${AGENT_TASK_ID:-}" ]; then
        cmd=(claude --resume "$claude_active_session_id" -p --output-format stream-json --dangerously-skip-permissions)
      else
        cmd=(claude --resume "$claude_active_session_id" -p --verbose --output-format stream-json --dangerously-skip-permissions)
      fi
      cmd+=(--disallowedTools "${claude_disallowed_tools[@]}")
      cmd+=(--append-system-prompt "$system_prompt")
      if [ -n "$agent_model" ]; then
        cmd+=(--model "$agent_model")
      fi
      if [ -n "$claude_plugin_dir" ]; then
        cmd+=(--plugin-dir "$claude_plugin_dir")
      fi
      cmd+=("--" "$claude_resume_user_message")
    else
      if [ -n "$session_resume_key" ] && [ "$claude_resume_supported" -eq 1 ]; then
        log "Claude session resume: no saved session for key=${agent_session_key}; starting fresh"
      fi
      cmd=("${claude_fresh_cmd[@]}")
    fi
    run_in_repo=1
    ;;

  kilo)
    if ! command -v kilo >/dev/null 2>&1; then
      echo "kilo CLI is not installed in the container." >&2
      exit 1
    fi
    kilo_provider="${KILO_PROVIDER:-}"
    kilocode_token="${KILOCODE_TOKEN:-}"

    # Validate auth: KILOCODE_TOKEN (gateway) or KILO_PROVIDER + matching API key (BYOK).
    if [ -z "$kilocode_token" ]; then
      if [ -z "$kilo_provider" ]; then
        echo "KILO_PROVIDER is required when AGENT_PROVIDER=kilo (unless KILOCODE_TOKEN is set for gateway mode)." >&2
        exit 1
      fi
      case "$kilo_provider" in
        anthropic)
          if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
            echo "ANTHROPIC_API_KEY is required when KILO_PROVIDER=anthropic." >&2
            exit 1
          fi
          ;;
        openai)
          if [ -z "${OPENAI_API_KEY:-}" ]; then
            echo "OPENAI_API_KEY is required when KILO_PROVIDER=openai." >&2
            exit 1
          fi
          ;;
        google)
          if [ -z "${GOOGLE_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
            echo "GOOGLE_API_KEY (or GEMINI_API_KEY) is required when KILO_PROVIDER=google." >&2
            exit 1
          fi
          ;;
        openrouter)
          if [ -z "${OPENROUTER_API_KEY:-}" ]; then
            echo "OPENROUTER_API_KEY is required when KILO_PROVIDER=openrouter." >&2
            exit 1
          fi
          ;;
      esac
      log "Kilo BYOK mode: provider=${kilo_provider}"
    else
      log "Kilo gateway mode (KILOCODE_TOKEN set)"
    fi

    cmd=(kilo run --auto)
    kilo_model="${KILO_MODEL:-}"
    if [ -n "$kilo_model" ]; then
      cmd+=(-m "$kilo_model")
      log "Kilo model override: ${kilo_model}"
    fi
    cmd+=("$prompt")
    run_in_repo=1
    ;;

  opencode)
    if ! command -v opencode >/dev/null 2>&1; then
      echo "opencode CLI is not installed in the container." >&2
      exit 1
    fi
    opencode_provider="${OPENCODE_PROVIDER:-}"

    # Validate auth: BYOK with provider API key or interactive auth
    if [ -n "$opencode_provider" ]; then
      case "$opencode_provider" in
        zai)
          if [ -z "${ZAI_API_KEY:-}" ]; then
            echo "ZAI_API_KEY is required when OPENCODE_PROVIDER=zai." >&2
            exit 1
          fi
          ;;
      esac
      log "OpenCode BYOK mode: provider=${opencode_provider}"
    elif [ -f "${HOME}/.local/share/opencode/auth.json" ]; then
      log "OpenCode interactive auth mode (cached auth.json)"
    else
      echo "OpenCode auth not configured. Set OPENCODE_PROVIDER + API key, or run: opencode auth login." >&2
      exit 1
    fi

    cmd=(opencode run)
    opencode_model="${OPENCODE_MODEL:-}"
    if [ -n "$opencode_model" ]; then
      cmd+=(--model "$opencode_model")
      log "OpenCode model: ${opencode_model}"
    fi
    cmd+=("$prompt")
    run_in_repo=1
    ;;

  *)
    echo "Unsupported AGENT_PROVIDER: ${provider}. Use codex|gemini|claude|kilo|opencode." >&2
    exit 1
    ;;
esac

log "Starting provider=${provider} auth_mode=${auth_mode} repo=${target_repo}"
# Capture exit code via temp file instead of PIPESTATUS so the tee pipe
# cannot silently swallow the command's real exit code.
exit_code=0
run_selected_command() {
  local ec_file=""
  local attempt_log_file=""

  ec_file="$(mktemp)"
  _cleanup_files+=("$ec_file")
  # `log_file` is the full merged run log across attempts.
  # `attempt_log_file` is only this attempt; `last_command_log` points to
  # the most recent attempt so session-id extraction is attempt-scoped.
  attempt_log_file="$(mktemp "${log_dir}/${run_id}.attempt.XXXXXX.log")"
  if [ -n "${last_command_log:-}" ] && [ "$last_command_log" != "$log_file" ] && [ -f "$last_command_log" ]; then
    rm -f "$last_command_log"
  fi
  set +e
  if [ "$run_in_repo" = "1" ]; then
    if command -v timeout >/dev/null 2>&1; then
      (cd "$repo_dir" && timeout "$timeout_secs" "${cmd[@]}"; printf '%d' "$?" > "$ec_file") 2>&1 | tee -a "$log_file" | tee "$attempt_log_file"
    else
      (cd "$repo_dir" && "${cmd[@]}"; printf '%d' "$?" > "$ec_file") 2>&1 | tee -a "$log_file" | tee "$attempt_log_file"
    fi
  else
    if command -v timeout >/dev/null 2>&1; then
      (timeout "$timeout_secs" "${cmd[@]}"; printf '%d' "$?" > "$ec_file") 2>&1 | tee -a "$log_file" | tee "$attempt_log_file"
    else
      ("${cmd[@]}"; printf '%d' "$?" > "$ec_file") 2>&1 | tee -a "$log_file" | tee "$attempt_log_file"
    fi
  fi
  exit_code="$(cat "$ec_file")"
  rm -f "$ec_file"
  last_command_log="$attempt_log_file"
  set -e
}

# Keep a persistent merged log for operator debugging across retries.
: > "$log_file"
# Start with merged log sentinel; run_selected_command updates this to the
# per-attempt file after each run.
last_command_log="$log_file"
_event_seq=$((_event_seq + 1))
log_event "$events_file" run.start "$agent_name" "$run_id" "$_event_seq"
workload_pre_execute
run_selected_command

# Strict policy: at most one resume failure before forcing fresh.
if [ "$provider" = "codex" ] && [ "$codex_used_resume" -eq 1 ] && [ "$exit_code" -ne 0 ]; then
  log "Codex session resume failed once; retrying with a fresh session"
  cmd=("${codex_fresh_cmd[@]}")
  codex_used_resume=0
  codex_active_session_id=""
  codex_active_session_created_epoch=""
  run_selected_command
fi

if [ "$provider" = "claude" ] && [ "$claude_used_resume" -eq 1 ] && [ "$exit_code" -ne 0 ]; then
  log "Claude session resume failed once; retrying with a fresh session"
  cmd=("${claude_fresh_cmd[@]}")
  claude_used_resume=0
  claude_active_session_id=""
  claude_active_session_created_epoch=""
  run_selected_command
fi

if [ "$provider" = "codex" ] && [ -n "$session_resume_key" ] && [ "$exit_code" -eq 0 ]; then
  codex_session_from_log="$(extract_codex_session_id_from_log "$last_command_log")"
  if is_valid_uuid "$codex_session_from_log"; then
    codex_saved_at_epoch="$(date +%s)"
    codex_created_to_store="$codex_saved_at_epoch"
    if [ "$codex_used_resume" -eq 1 ] \
      && [ -n "$codex_active_session_id" ] \
      && [ "$codex_session_from_log" = "$codex_active_session_id" ] \
      && is_non_negative_integer "$codex_active_session_created_epoch"; then
      codex_created_to_store="$codex_active_session_created_epoch"
    fi
    save_session_record_for_key "$provider_session_map_file" "$session_resume_key" \
      "$codex_session_from_log" "$codex_created_to_store" "$codex_saved_at_epoch"
    log "Codex session saved: key=${agent_session_key} session=${codex_session_from_log}"
  else
    log "Codex session id not found in log for key=${agent_session_key}"
  fi
fi

if [ "$provider" = "claude" ] && [ -n "$session_resume_key" ] && [ "$exit_code" -eq 0 ]; then
  claude_session_from_log="$(extract_claude_session_id_from_log "$last_command_log")"
  if is_valid_uuid "$claude_session_from_log"; then
    claude_saved_at_epoch="$(date +%s)"
    claude_created_to_store="$claude_saved_at_epoch"
    if [ "$claude_used_resume" -eq 1 ] \
      && [ -n "$claude_active_session_id" ] \
      && [ "$claude_session_from_log" = "$claude_active_session_id" ] \
      && is_non_negative_integer "$claude_active_session_created_epoch"; then
      claude_created_to_store="$claude_active_session_created_epoch"
    fi
    save_session_record_for_key "$provider_session_map_file" "$session_resume_key" \
      "$claude_session_from_log" "$claude_created_to_store" "$claude_saved_at_epoch"
    log "Claude session saved: key=${agent_session_key} session=${claude_session_from_log}"
  else
    log "Claude session id not found in log for key=${agent_session_key}"
  fi
fi

# Let the workload handle post-execution concerns (e.g. messaging
# workload sends the response back and stops the typing indicator).
workload_post_execute "$exit_code" "${last_command_log:-}" "$provider"

if [ "$exit_code" -eq 124 ]; then
  log "Run timed out after ${timeout_secs}s"
fi

run_end_epoch="$(date +%s)"
run_duration_secs=$((run_end_epoch - run_start_epoch))
_event_seq=$((_event_seq + 1))
if [ "$exit_code" -eq 0 ]; then
  log_event "$events_file" run.complete "$agent_name" "$run_id" "$_event_seq" \
    "\"duration_secs\":${run_duration_secs},\"outcome\":\"success\""
  write_health_snapshot "$health_file" "$agent_name" "$run_id" run.complete 0
else
  _run_error="run_failed"
  if [ "$exit_code" -eq 124 ]; then
    _run_error="timeout"
  fi
  _consecutive_failures="${AGENT_CONSECUTIVE_FAILURES:-0}"
  log_event "$events_file" run.error "$agent_name" "$run_id" "$_event_seq" \
    "\"error\":\"${_run_error}\",\"exit_code\":${exit_code},\"consecutive_failures\":${_consecutive_failures}"
  write_health_snapshot "$health_file" "$agent_name" "$run_id" run.error "$_consecutive_failures"
fi

# ── V2 health reporting to backend ──────────────────────────────
# Source the health reporter library (best-effort, never affects exit code).
# shellcheck source=shared/health-reporter.sh
. "${SHARED_DIR}/health-reporter.sh"

# Update persistent agent stats (atomic read-modify-write).
stats_file="${log_dir}/agent-stats.json"
_is_error=0
[ "$exit_code" -ne 0 ] && _is_error=1
update_agent_stats "$stats_file" "$_is_error" >/dev/null

# Best-effort health report (never affects exit code).
if [ -n "${HEALTH_REPORT_URL:-}" ]; then
  _run_outcome="success"
  if [ "$exit_code" -eq 124 ]; then
    _run_outcome="timeout"
  elif [ "$exit_code" -ne 0 ]; then
    _run_outcome="failure"
  fi

  # Compute next_run_at when running on a periodic schedule.
  # PERIODIC_INTERVAL_SECS is exported by run-loop.sh; unset for standalone/mention runs.
  # This is a nominal floor (now + interval), not a hard guarantee. On failure,
  # run-loop.sh applies exponential backoff that can defer the actual next run
  # beyond this timestamp. Dashboards should treat this as best-effort and avoid
  # tight "overdue" thresholds — a run landing later than next_run_at is not
  # necessarily late, especially when PERIODIC_INTERVAL_SECS < backoff minimums.
  _next_run_at=""
  if [ -n "${PERIODIC_INTERVAL_SECS:-}" ] && printf '%s' "$PERIODIC_INTERVAL_SECS" | grep -Eq '^[1-9][0-9]*$'; then
    _next_run_at="$(date -u -d "+${PERIODIC_INTERVAL_SECS} seconds" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
      || date -u -v "+${PERIODIC_INTERVAL_SECS}S" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
      || true)"
  fi

  # Extract token usage from the per-attempt log (best-effort; empty string if unavailable).
  _token_usage_json=""
  if [ -n "${last_command_log:-}" ] && [ -f "${last_command_log}" ]; then
    case "$provider" in
      claude) _token_usage_json="$(extract_claude_token_usage_from_log "$last_command_log")" || true ;;
      codex)  _token_usage_json="$(extract_codex_token_usage_from_log "$last_command_log")" || true ;;
      *)      _token_usage_json="" ;;
    esac
  fi

  # Extract run summary from the per-attempt log (best-effort; empty string if unavailable).
  # Gated by HEALTH_REPORT_RUN_SUMMARY=1 (default off) to avoid sending the field to backends
  # that don't yet have run_summary in their HealthReport schema, which would turn valid
  # health reports into 400 responses during the migration window.
  _run_summary=""
  if [ "${HEALTH_REPORT_RUN_SUMMARY:-0}" = "1" ] && [ -n "${last_command_log:-}" ] && [ -f "${last_command_log}" ]; then
    _run_summary="$(extract_run_summary_from_log "$provider" "$last_command_log")" || true
  fi

  # Extract error_detail (sanitized log tail) on failure/timeout for diagnostics.
  # Gated by HEALTH_REPORT_ERROR_DETAIL=1 (default off) to avoid 400s during the
  # backend migration window.  Uses the per-attempt log when available, falls back
  # to the overall run log.
  _error_detail=""
  if [ "${HEALTH_REPORT_ERROR_DETAIL:-0}" = "1" ] && [ "$_run_outcome" != "success" ]; then
    _error_detail_log="${last_command_log:-}"
    if [ ! -f "${_error_detail_log:-}" ]; then
      _error_detail_log="${log_file:-}"
    fi
    if [ -f "${_error_detail_log}" ]; then
      _error_detail="$(_extract_error_detail_from_log "$_error_detail_log")" || true
    fi
  fi

  report_health_to_backend \
    "$agent_name" "$target_repo" "${HIVEMOOT_AGENT_TOKEN:-}" \
    "$run_id" "$_run_outcome" "$run_duration_secs" "${_consecutive_failures:-0}" \
    "$exit_code" "${_run_error:-}" "$_next_run_at" \
    "${RUN_TRIGGER_TYPE:-manual}" "$_token_usage_json" "$_run_summary" "$_error_detail" || true
fi

if [ -n "${last_command_log:-}" ] && [ "$last_command_log" != "$log_file" ] && [ -f "$last_command_log" ]; then
  rm -f "$last_command_log"
fi

log "Run finished with exit_code=${exit_code}. Log: ${log_file}"
exit "$exit_code"
