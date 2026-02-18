#!/usr/bin/env bash
# Unified loop mode: periodic agent runs with optional mention-triggered runs
# via WATCH_MENTIONS=1. Per-agent locks prevent concurrent execution.
set -euo pipefail

log() {
  printf '[run-loop %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"
# shellcheck source=scripts/opencode-helpers.sh
. "${SCRIPT_DIR}/opencode-helpers.sh"

# ── Configuration ──────────────────────────────────────────────────

workspace_root="${WORKSPACE_ROOT:-/workspace}"
email_domain="${AGENT_GIT_EMAIL_DOMAIN:-agents.local}"
global_extra_prompt="${AGENT_EXTRA_PROMPT:-}"
target_repo="${TARGET_REPO:-}"
max_agents=10
token_tmp_root="/tmp/hivemoot-agent-token-files"
lock_dir="/tmp/agent-locks"
agent_run_busy_exit=3

# Periodic scheduling (backward compat: fall back to BASE_SECS / JITTER_SECS)
periodic_interval="${PERIODIC_INTERVAL_SECS:-${BASE_SECS:-3600}}"
periodic_jitter="${PERIODIC_JITTER_SECS:-${JITTER_SECS:-300}}"
max_failures="${MAX_CONSECUTIVE_FAILURES:-5}"
agent_failure_backoff_base="${PERIODIC_AGENT_FAILURE_BACKOFF_BASE_SECS:-300}"
agent_failure_backoff_max="${PERIODIC_AGENT_FAILURE_BACKOFF_MAX_SECS:-3600}"
agent_failure_backoff_jitter_pct="${PERIODIC_AGENT_FAILURE_BACKOFF_JITTER_PCT:-15}"

# Mention watching (opt-in)
watch_mentions="${WATCH_MENTIONS:-}"
watch_poll_interval="${WATCH_POLL_INTERVAL:-300}"

# Validate numeric settings
for var_name in periodic_interval periodic_jitter max_failures \
  agent_failure_backoff_base agent_failure_backoff_max agent_failure_backoff_jitter_pct; do
  val="${!var_name}"
  case "$val" in
    ''|*[!0-9]*) echo "${var_name} must be a non-negative integer" >&2; exit 1 ;;
  esac
done

if [ "$periodic_interval" -le 0 ]; then
  echo "PERIODIC_INTERVAL_SECS must be > 0" >&2; exit 1
fi
if [ "$max_failures" -le 0 ]; then
  echo "MAX_CONSECUTIVE_FAILURES must be > 0" >&2; exit 1
fi
if [ "$agent_failure_backoff_max" -le 0 ]; then
  echo "PERIODIC_AGENT_FAILURE_BACKOFF_MAX_SECS must be > 0" >&2; exit 1
fi
if [ "$agent_failure_backoff_base" -gt "$agent_failure_backoff_max" ]; then
  echo "PERIODIC_AGENT_FAILURE_BACKOFF_BASE_SECS must be <= PERIODIC_AGENT_FAILURE_BACKOFF_MAX_SECS" >&2
  exit 1
fi
if [ "$agent_failure_backoff_jitter_pct" -gt 100 ]; then
  echo "PERIODIC_AGENT_FAILURE_BACKOFF_JITTER_PCT must be between 0 and 100" >&2
  exit 1
fi

if [ "$watch_mentions" = "1" ]; then
  case "$watch_poll_interval" in
    ''|*[!0-9]*) echo "WATCH_POLL_INTERVAL must be a non-negative integer" >&2; exit 1 ;;
  esac
  if [ "$watch_poll_interval" -eq 0 ]; then
    echo "WATCH_POLL_INTERVAL must be > 0" >&2; exit 1
  fi
  if [ -z "$target_repo" ]; then
    echo "TARGET_REPO is required when WATCH_MENTIONS=1." >&2
    exit 1
  fi
fi

validate_target_repo "$target_repo"

# ── Agent Slot Parsing ─────────────────────────────────────────────

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

  case "$agent_id" in
    ''|*[!a-zA-Z0-9._-]*)
      echo "Invalid agent id: ${agent_id}" >&2
      exit 1
      ;;
  esac

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

agent_count="${#agent_ids[@]}"

# Write tokens to temp files and clear env vars
declare -a temp_token_files=()
mkdir -p "$token_tmp_root"
chmod 700 "$token_tmp_root" 2>/dev/null || true

declare -A agent_token_files=()
for index in "${!agent_ids[@]}"; do
  aid="${agent_ids[$index]}"
  tok="${agent_tokens[$index]}"
  token_file="$(mktemp "${token_tmp_root}/${aid}.XXXXXX")"
  printf '%s' "$tok" > "$token_file"
  chmod 600 "$token_file" 2>/dev/null || true
  temp_token_files+=("$token_file")
  agent_token_files["$aid"]="$token_file"
done

for slot in $(seq 1 "$max_agents"); do
  suffix="$(printf '%02d' "$slot")"
  unset "AGENT_GITHUB_TOKEN_${suffix}" "AGENT_GITHUB_TOKEN_${suffix}_FILE" || true
done

# ── Preflight ──────────────────────────────────────────────────────

preflight_check() {
  local failures=0

  log "Pre-flight: validating configuration"

  local provider="${AGENT_PROVIDER:-claude}"
  local auth_mode="${AGENT_AUTH_MODE:-auto}"
  local prompt_file="${AGENT_PROMPT_FILE:-/opt/hivemoot-agent/prompts/default.md}"

  if ! command -v "$provider" >/dev/null 2>&1; then
    echo "Pre-flight: ${provider} CLI is not installed." >&2
    failures=$((failures + 1))
  fi

  if ! command -v hivemoot >/dev/null 2>&1; then
    echo "Pre-flight: hivemoot CLI is not installed." >&2
    failures=$((failures + 1))
  fi

  if [ ! -f "$prompt_file" ]; then
    echo "Pre-flight: prompt file not found: ${prompt_file}" >&2
    failures=$((failures + 1))
  fi

  # Provider auth check
  case "$provider" in
    codex)
      local resolved="$auth_mode"
      [ "$resolved" = "auto" ] && resolved=$( [ -n "${OPENAI_API_KEY:-}" ] && echo "api_key" || echo "subscription" )
      if [ "$resolved" = "api_key" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
        echo "Pre-flight: OPENAI_API_KEY missing for codex + api_key mode." >&2
        failures=$((failures + 1))
      fi
      ;;
    gemini)
      local resolved="$auth_mode"
      [ "$resolved" = "auto" ] && resolved=$( { [ -n "${GOOGLE_API_KEY:-}" ] || [ -n "${GEMINI_API_KEY:-}" ]; } && echo "api_key" || echo "subscription" )
      if [ "$resolved" = "api_key" ] && [ -z "${GOOGLE_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "Pre-flight: GOOGLE_API_KEY/GEMINI_API_KEY missing for gemini + api_key mode." >&2
        failures=$((failures + 1))
      fi
      ;;
    claude)
      local resolved="$auth_mode"
      [ "$resolved" = "auto" ] && resolved=$( [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "api_key" || echo "subscription" )
      if [ "$resolved" = "api_key" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        echo "Pre-flight: ANTHROPIC_API_KEY missing for claude + api_key mode." >&2
        failures=$((failures + 1))
      fi
      ;;
    kilo)
      if [ -z "${KILOCODE_TOKEN:-}" ]; then
        if [ -z "${KILO_PROVIDER:-}" ]; then
          echo "Pre-flight: KILO_PROVIDER is required for kilo (unless KILOCODE_TOKEN is set for gateway mode)." >&2
          failures=$((failures + 1))
        else
          case "${KILO_PROVIDER}" in
            anthropic)
              if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
                echo "Pre-flight: ANTHROPIC_API_KEY missing for KILO_PROVIDER=anthropic." >&2
                failures=$((failures + 1))
              fi
              ;;
            openai)
              if [ -z "${OPENAI_API_KEY:-}" ]; then
                echo "Pre-flight: OPENAI_API_KEY missing for KILO_PROVIDER=openai." >&2
                failures=$((failures + 1))
              fi
              ;;
            google)
              if [ -z "${GOOGLE_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
                echo "Pre-flight: GOOGLE_API_KEY/GEMINI_API_KEY missing for KILO_PROVIDER=google." >&2
                failures=$((failures + 1))
              fi
              ;;
            openrouter)
              if [ -z "${OPENROUTER_API_KEY:-}" ]; then
                echo "Pre-flight: OPENROUTER_API_KEY missing for KILO_PROVIDER=openrouter." >&2
                failures=$((failures + 1))
              fi
              ;;
          esac
        fi
      fi
      ;;
    opencode)
      if [ -n "${OPENCODE_PROVIDER:-}" ]; then
        case "${OPENCODE_PROVIDER}" in
          zai)
            if [ -z "${ZAI_API_KEY:-}" ]; then
              echo "Pre-flight: ZAI_API_KEY missing for OPENCODE_PROVIDER=zai." >&2
              failures=$((failures + 1))
            fi
            ;;
        esac
      elif [ ! -f "/home/node/.local/share/opencode/auth.json" ]; then
        echo "Pre-flight: OpenCode auth not configured. Set OPENCODE_PROVIDER + API key, or run: opencode auth login." >&2
        failures=$((failures + 1))
      fi
      ;;
  esac

  # Validate agent tokens against GitHub API
  for index in "${!agent_ids[@]}"; do
    local aid="${agent_ids[$index]}"
    local tok="${agent_tokens[$index]}"

    if [ "$watch_mentions" = "1" ]; then
      # Mention watching requires user tokens (for notifications API)
      if ! GH_TOKEN="$tok" gh api user --jq .login >/dev/null 2>&1; then
        echo "Pre-flight: token for agent '${aid}' is not a valid user token (required for WATCH_MENTIONS=1)." >&2
        failures=$((failures + 1))
        continue
      fi
    else
      # Periodic-only mode accepts both user and installation tokens
      if ! GH_TOKEN="$tok" gh api user --jq .login >/dev/null 2>&1; then
        if ! GH_TOKEN="$tok" gh api installation --jq .id >/dev/null 2>&1; then
          echo "Pre-flight: token for agent '${aid}' is invalid or expired." >&2
          failures=$((failures + 1))
          continue
        fi
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
    echo "Pre-flight: ${failures} check(s) failed." >&2
    exit 1
  fi

  log "Pre-flight: all checks passed (agents=${agent_count} repo=${target_repo:-unset})"
}

preflight_check
prepare_hivemoot_cli

# ── Agent Home Setup ──────────────────────────────────────────────

for index in "${!agent_ids[@]}"; do
  aid="${agent_ids[$index]}"
  agent_home="${workspace_root}/homes/${aid}"

  mkdir -p \
    "$agent_home/.config" \
    "$agent_home/.cache" \
    "$agent_home/.local" \
    "$agent_home/.local/share"
  chmod 700 \
    "$agent_home/.config" \
    "$agent_home/.cache" \
    "$agent_home/.local" \
    "$agent_home/.local/share" 2>/dev/null || true

  # Copy shared provider auth state into each agent home
  seed_provider_home "/home/node/.codex" "$agent_home/.codex"
  seed_provider_home "/home/node/.gemini" "$agent_home/.gemini"
  seed_provider_home "/home/node/.claude" "$agent_home/.claude"
  seed_provider_home "/home/node/.config/claude" "$agent_home/.config/claude"
  seed_provider_home "/home/node/.config/kilo" "$agent_home/.config/kilo"
  seed_provider_home "/home/node/.config/opencode" "$agent_home/.config/opencode"
  seed_provider_home "/home/node/.local/share/opencode" "$agent_home/.local/share/opencode"

  # Generate OpenCode auth.json if missing (API key stored in auth.json,
  # not in config provider options). Must run after seed_provider_home so
  # the bind-mounted config is already in place.
  generate_opencode_config "$agent_home"

  # Ensure agent subprocesses can find npm-installed binaries
  # shellcheck disable=SC2016
  printf 'export PATH="/usr/local/share/npm-global/bin:${PATH}"\n' \
    > "$agent_home/.profile"
done

# ── Lock & Run Infrastructure ──────────────────────────────────────

mkdir -p "$lock_dir"

# Track all background PIDs for cleanup
declare -a all_bg_pids=()
shutdown_requested=0

# shellcheck disable=SC2317,SC2329  # invoked via trap
cleanup() {
  local path=""
  for path in "${temp_token_files[@]-}"; do
    rm -f "$path" 2>/dev/null || true
  done
}

# shellcheck disable=SC2317,SC2329  # invoked via trap
handle_shutdown() {
  if [ "$shutdown_requested" -eq 0 ]; then
    shutdown_requested=1
    log "Shutdown signal received; stopping background processes"
    for pid in "${all_bg_pids[@]-}"; do
      kill -TERM "$pid" 2>/dev/null || true
    done
  fi
}

trap cleanup EXIT
trap handle_shutdown TERM INT

# Try to run an agent with per-agent flock.
# Returns 0 on successful run-once.sh completion.
# Returns ${agent_run_busy_exit} when the agent was busy (lock not acquired).
# Returns non-zero/non-3 on actual run-once.sh failure.
#
# Args: agent_id extra_prompt [ack_key state_file]
# When ack_key + state_file are provided and the run succeeds (exit 0),
# calls `hivemoot ack` to mark the mention as read. On failure the mention
# stays unread so the next poll cycle retries it.
try_run_agent() {
  local agent_id="$1"
  local extra_prompt="$2"
  local ack_key="${3:-}"
  local state_file="${4:-}"
  local lock_file="${lock_dir}/${agent_id}.lock"
  local token_file="${agent_token_files[$agent_id]}"
  local agent_workspace="${workspace_root}/agents/${agent_id}"
  local agent_repo="${agent_workspace}/repo"
  local agent_log_dir="${workspace_root}/runs/${agent_id}"
  local agent_home="${workspace_root}/homes/${agent_id}"

  mkdir -p "$agent_workspace" "$agent_log_dir" "$agent_home"

  (
    flock -n 200 || { log "${agent_id}: busy, skipping"; exit "$agent_run_busy_exit"; }

    log "${agent_id}: lock acquired, starting run"

    export HOME="$agent_home"
    export WORKSPACE_ROOT="$agent_workspace"
    export REPO_DIR="$agent_repo"
    export LOG_DIR="$agent_log_dir"
    export AGENT_GITHUB_TOKEN_FILE="$token_file"
    export AGENT_GIT_NAME="$agent_id"
    export AGENT_GIT_EMAIL="${agent_id}@${email_domain}"
    export HIVEMOOT_BUZZ_ROLE="$agent_id"
    export AGENT_EXTRA_PROMPT="$extra_prompt"

    unset AGENT_GITHUB_TOKEN GITHUB_TOKEN GH_TOKEN

    agent_exit=0
    /opt/hivemoot-agent/scripts/run-once.sh || agent_exit=$?

    if [ "$agent_exit" -ne 0 ]; then
      log "${agent_id}: run exited with code ${agent_exit}"
    fi

    # Deferred ack: only mark notification as read after a successful run.
    # On failure the mention stays unread so the next poll cycle retries it.
    if [ "$agent_exit" -eq 0 ] && [ -n "$ack_key" ] && [ -n "$state_file" ]; then
      GH_TOKEN="$(cat "$token_file")" hivemoot ack "$ack_key" \
        --state-file "$state_file" || log "${agent_id}: ack failed for ${ack_key}"
    fi

    log "${agent_id}: lock released"
    exit "$agent_exit"
  ) 200>"$lock_file"
}

calculate_agent_backoff_delay() {
  local failure_count="$1"
  local delay="$agent_failure_backoff_base"

  if [ "$failure_count" -le 0 ] || [ "$delay" -le 0 ]; then
    echo 0
    return
  fi

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

# ── Mention Watchers (one per agent, only when WATCH_MENTIONS=1) ──

start_mention_watcher() {
  local agent_id="$1"
  local agent_token="${agent_tokens[$2]}"
  local agent_workspace="${workspace_root}/agents/${agent_id}"
  local state_file="${agent_workspace}/watch-state.json"

  mkdir -p "$agent_workspace"

  log "Starting mention watcher for ${agent_id}"

  # Run hivemoot watch in a supervised subshell with restart-on-failure.
  # Backoff resets when the watcher survives longer than 60s (not an immediate crash).
  (
    restart_delay=5
    max_delay=300

    while true; do
      start_time=$SECONDS

      GH_TOKEN="$agent_token" hivemoot watch \
        --repo "$target_repo" \
        --state-file "$state_file" \
        --interval "$watch_poll_interval" 2>&1 | while IFS= read -r line; do

        # Skip non-JSON lines (stderr log messages mixed in)
        if ! printf '%s' "$line" | jq -e . >/dev/null 2>&1; then
          printf '[watcher:%s] %s\n' "$agent_id" "$line" >&2
          continue
        fi

        local thread_id=""
        local number=""
        local title=""
        local author=""
        local body=""
        local url=""

        thread_id="$(printf '%s' "$line" | jq -r '.threadId // empty')"
        number="$(printf '%s' "$line" | jq -r '.number // empty')"
        title="$(printf '%s' "$line" | jq -r '.title // empty')"
        author="$(printf '%s' "$line" | jq -r '.author // empty')"
        body="$(printf '%s' "$line" | jq -r '.body // empty')"
        url="$(printf '%s' "$line" | jq -r '.url // empty')"
        timestamp="$(printf '%s' "$line" | jq -r '.timestamp // empty')"

        log "${agent_id}: mention detected on #${number} by @${author}"

        # Build the extra prompt with mention context
        local mention_prompt="PRIORITY: You were @mentioned on #${number}: \"${title}\".
Mentioned by: @${author}
Comment: \"${body}\"
URL: ${url}

First, react to the comment with a 👀 (eyes) reaction to let the author know you are looking into this.
Then read the full thread, research the topic, and take appropriate action with a meaningful response."

        local combined_prompt="${global_extra_prompt:+${global_extra_prompt}

}${mention_prompt}"

        # Build ack key (threadId:updatedAt) for deferred acknowledgment
        local ack_key=""
        if [ -n "$thread_id" ] && [ -n "$timestamp" ]; then
          ack_key="${thread_id}:${timestamp}"
        fi

        # Try to acquire agent lock and run; pass ack info for deferred mark-read.
        # Redirect stdin from /dev/null so the backgrounded child doesn't inherit
        # the pipe fd — inherited pipe fds can flip to O_NONBLOCK and cause the
        # parent while-read loop to fail with EAGAIN, killing the watcher.
        try_run_agent "$agent_id" "$combined_prompt" "$ack_key" "$state_file" </dev/null &

      done || true  # Don't let pipefail+errexit kill the restart loop

      # Reset backoff if watcher ran for more than 60s (not an immediate crash)
      elapsed=$((SECONDS - start_time))
      if [ "$elapsed" -gt 60 ]; then
        restart_delay=5
      fi

      log "${agent_id}: watcher exited after ${elapsed}s, restarting in ${restart_delay}s"
      sleep "$restart_delay" &
      wait $! || break

      restart_delay=$((restart_delay * 2))
      if [ "$restart_delay" -gt "$max_delay" ]; then
        restart_delay="$max_delay"
      fi
    done
  ) &

  local watcher_pid=$!
  all_bg_pids+=("$watcher_pid")
  log "Mention watcher for ${agent_id} started (pid=${watcher_pid})"
}

# ── Periodic Scheduler ─────────────────────────────────────────────

start_periodic_scheduler() {
  log "Starting periodic scheduler (interval=${periodic_interval}s +/-${periodic_jitter}s)"

  (
    consecutive_failures=0
    declare -A agent_failure_counts=()
    declare -A agent_next_retry_at=()

    # This subshell terminates via SIGTERM from handle_shutdown, not via
    # a shared variable (subshells get a frozen copy of parent state).
    while true; do
      # Sleep first — agents just started, give watchers time to settle
      effective_jitter="$periodic_jitter"
      if [ "$effective_jitter" -ge "$periodic_interval" ]; then
        effective_jitter=$((periodic_interval - 1))
      fi
      min_delay=$((periodic_interval - effective_jitter))
      max_delay=$((periodic_interval + effective_jitter))
      span=$((max_delay - min_delay + 1))
      delay=$((min_delay + RANDOM % span))

      log "Periodic: sleeping ${delay}s before next cycle"
      sleep "$delay" &
      wait $! || true

      log "Periodic: starting cycle for ${agent_count} agents"

      declare -a cycle_pids=()
      declare -A pid_to_agent=()
      cycle_skipped=0
      cycle_started=0
      now_epoch="$(date +%s)"

      for index in "${!agent_ids[@]}"; do
        aid="${agent_ids[$index]}"
        next_retry="${agent_next_retry_at[$aid]:-0}"

        if [ "$next_retry" -gt "$now_epoch" ]; then
          remaining=$((next_retry - now_epoch))
          log "Periodic: ${aid} in cooldown (${remaining}s remaining), skipping"
          cycle_skipped=$((cycle_skipped + 1))
          continue
        fi

        try_run_agent "$aid" "$global_extra_prompt" &
        pid=$!
        cycle_pids+=("$pid")
        pid_to_agent["$pid"]="$aid"
        cycle_started=$((cycle_started + 1))
      done

      # Wait for all agent runs and track results
      cycle_failures=0
      cycle_busy=0
      cycle_ok=0
      for pid in "${cycle_pids[@]}"; do
        aid="${pid_to_agent[$pid]}"
        if wait "$pid" 2>/dev/null; then
          run_status=0
        else
          run_status=$?
        fi

        if [ "$run_status" -eq 0 ]; then
          previous_failures="${agent_failure_counts[$aid]:-0}"
          if [ "$previous_failures" -gt 0 ]; then
            log "Periodic: ${aid} recovered after ${previous_failures} failed cycle(s)"
          fi
          agent_failure_counts["$aid"]=0
          agent_next_retry_at["$aid"]=0
          cycle_ok=1
          continue
        fi

        if [ "$run_status" -eq "$agent_run_busy_exit" ]; then
          cycle_busy=$((cycle_busy + 1))
          log "Periodic: ${aid} busy; keeping existing failure/backoff state"
          continue
        fi

        cycle_failures=$((cycle_failures + 1))
        current_failures="${agent_failure_counts[$aid]:-0}"
        current_failures=$((current_failures + 1))
        agent_failure_counts["$aid"]="$current_failures"

        backoff_delay="$(calculate_agent_backoff_delay "$current_failures")"
        failure_epoch="$(date +%s)"
        retry_at=$((failure_epoch + backoff_delay))
        agent_next_retry_at["$aid"]="$retry_at"

        if [ "$current_failures" -eq 1 ]; then
          log "Periodic: ${aid} entered failure backoff mode"
        fi

        if [ "$backoff_delay" -gt 0 ]; then
          log "Periodic: ${aid} failed (${current_failures}x); cooldown ${backoff_delay}s"
        else
          log "Periodic: ${aid} failed (${current_failures}x); retrying next cycle"
        fi
      done

      if [ "$cycle_started" -eq 0 ] && [ "$cycle_skipped" -gt 0 ]; then
        log "Periodic: no agents eligible this cycle (${cycle_skipped} in cooldown)"
      fi

      if [ "$cycle_busy" -gt 0 ]; then
        log "Periodic: ${cycle_busy} agent(s) were lock-busy this cycle"
      fi

      if [ "$cycle_ok" -eq 1 ]; then
        consecutive_failures=0
        log "Periodic: cycle completed (started=${cycle_started} skipped=${cycle_skipped} busy=${cycle_busy} failed=${cycle_failures})"
      else
        if [ "$cycle_started" -eq 0 ]; then
          log "Periodic: cycle had no runnable agents; not counting as a failure streak"
        elif [ "$cycle_failures" -eq 0 ]; then
          log "Periodic: cycle had no completed runs (busy=${cycle_busy}); not counting as a failure streak"
        else
          consecutive_failures=$((consecutive_failures + 1))
          log "Periodic: cycle failed (started=${cycle_started} skipped=${cycle_skipped} busy=${cycle_busy} consecutive_failures=${consecutive_failures})"
          if [ "$consecutive_failures" -ge "$max_failures" ]; then
            log "Periodic: reached max consecutive failures (${max_failures}); exiting"
            kill -TERM $$ 2>/dev/null || true
            exit 1
          fi
        fi
      fi
    done
  ) &

  local scheduler_pid=$!
  all_bg_pids+=("$scheduler_pid")
  log "Periodic scheduler started (pid=${scheduler_pid})"
}

# ── Main ───────────────────────────────────────────────────────────

log "Loop mode starting: ${agent_count} agents, repo=${target_repo:-unset}"
log "  Periodic interval: ${periodic_interval}s +/-${periodic_jitter}s"
log "  Periodic failure backoff: base=${agent_failure_backoff_base}s max=${agent_failure_backoff_max}s jitter=${agent_failure_backoff_jitter_pct}%"
if [ "$watch_mentions" = "1" ]; then
  log "  Mention watching: enabled (poll interval: ${watch_poll_interval}s)"
else
  log "  Mention watching: disabled (set WATCH_MENTIONS=1 to enable)"
fi
log "  Max consecutive failures: ${max_failures}"

# Start mention watchers if enabled
if [ "$watch_mentions" = "1" ]; then
  for index in "${!agent_ids[@]}"; do
    start_mention_watcher "${agent_ids[$index]}" "$index"
  done
fi

# Start periodic scheduler
start_periodic_scheduler

# Wait for all background processes
log "All background processes running. Waiting..."
wait

log "Graceful shutdown complete"
exit 0
