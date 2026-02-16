#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[run-multi %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

seed_provider_home() {
  local shared_path="$1"
  local agent_path="$2"

  if [ ! -e "$shared_path" ]; then
    return 0
  fi

  if [ -d "$shared_path" ]; then
    mkdir -p "$agent_path"
    cp -R "$shared_path"/. "$agent_path"/
  else
    mkdir -p "$(dirname "$agent_path")"
    cp "$shared_path" "$agent_path"
  fi
}

# Selective auth seeding: copy only credential files for a provider,
# skipping conversation caches and session state. Use this instead of
# seed_provider_home when JOB_ID isolation is active.
# shellcheck disable=SC2317,SC2329  # available for JOB_ID callers
seed_provider_auth() {
  local agent_home="$1"
  local source_home="/home/node"

  # Claude Code: auth tokens in ~/.config/claude/
  if [ -d "${source_home}/.config/claude" ]; then
    mkdir -p "${agent_home}/.config/claude"
    cp -R "${source_home}/.config/claude"/. "${agent_home}/.config/claude"/
  fi
  # Claude Code: ~/.claude/ contains both auth and session state.
  # Seed only the OAuth credential file; skip auto-memory and projects/.
  if [ -f "${source_home}/.claude/.credentials.json" ]; then
    mkdir -p "${agent_home}/.claude"
    cp "${source_home}/.claude/.credentials.json" "${agent_home}/.claude/.credentials.json"
  fi

  # Codex: only auth.json
  if [ -f "${source_home}/.codex/auth.json" ]; then
    mkdir -p "${agent_home}/.codex"
    cp "${source_home}/.codex/auth.json" "${agent_home}/.codex/auth.json"
  fi
  # Codex: skip conversations/, cache/

  # Gemini: seed only known auth/credential files; skip session state
  # (memory.md, settings.json, state.json, telemetry, etc.)
  if [ -d "${source_home}/.gemini" ]; then
    mkdir -p "${agent_home}/.gemini"
    for f in oauth_creds.json google_accounts.json mcp-oauth-tokens.json mcp-oauth-tokens-v2.json .env; do
      if [ -f "${source_home}/.gemini/$f" ]; then
        cp "${source_home}/.gemini/$f" "${agent_home}/.gemini/$f"
      fi
    done
  fi
}

workspace_root="${WORKSPACE_ROOT:-/workspace}"
email_domain="${AGENT_GIT_EMAIL_DOMAIN:-agents.local}"
global_extra_prompt="${AGENT_EXTRA_PROMPT:-}"
target_repo="${TARGET_REPO:-}"
launch_jitter_min="${LAUNCH_JITTER_MIN_SECS:-120}"
launch_jitter_max="${LAUNCH_JITTER_MAX_SECS:-180}"
max_agents=10
token_tmp_root="/tmp/hivemoot-agent-token-files"

case "$launch_jitter_min" in
  ''|*[!0-9]*) echo "LAUNCH_JITTER_MIN_SECS must be a non-negative integer" >&2; exit 1 ;;
esac
case "$launch_jitter_max" in
  ''|*[!0-9]*) echo "LAUNCH_JITTER_MAX_SECS must be a non-negative integer" >&2; exit 1 ;;
esac
if [ "$launch_jitter_max" -lt "$launch_jitter_min" ]; then
  echo "LAUNCH_JITTER_MAX_SECS (${launch_jitter_max}) must be >= LAUNCH_JITTER_MIN_SECS (${launch_jitter_min})" >&2
  exit 1
fi

if [ -z "$target_repo" ]; then
  echo "TARGET_REPO is required. Set it as owner/repo." >&2
  exit 1
fi
if ! printf '%s' "$target_repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "Invalid TARGET_REPO: ${target_repo}. Expected owner/repo." >&2
  exit 1
fi

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

load_slot_token() {
  local suffix="$1"
  local token_var="AGENT_GITHUB_TOKEN_${suffix}"
  local token_file_var="${token_var}_FILE"
  local token="${!token_var:-}"
  local token_file="${!token_file_var:-}"

  if [ -n "$token" ] && [ -n "$token_file" ]; then
    echo "Set either ${token_var} or ${token_file_var}, not both." >&2
    exit 1
  fi

  if [ -z "$token" ] && [ -n "$token_file" ]; then
    if [ ! -f "$token_file" ]; then
      echo "${token_file_var} does not exist: ${token_file}" >&2
      exit 1
    fi
    token="$(tr -d '\r\n' < "$token_file")"
  fi

  printf '%s' "$token"
}

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

prepare_hivemoot_cli() {
  local update_mode="${HIVEMOOT_CLI_UPDATE:-auto}"
  local spec="@hivemoot-dev/cli@${HIVEMOOT_CLI_VERSION:-latest}"

  if [ "$update_mode" = "skip" ]; then
    log "Pre-run: skipping hivemoot CLI update (HIVEMOOT_CLI_UPDATE=skip)"
  else
    log "Pre-run: updating hivemoot CLI (${spec})"
    npm install -g "$spec"
    hash -r
  fi

  if ! command -v hivemoot >/dev/null 2>&1; then
    echo "hivemoot CLI is not available. Rebuild the image or set HIVEMOOT_CLI_UPDATE=auto." >&2
    exit 1
  fi

  local version_line=""
  version_line="$(hivemoot --version 2>/dev/null | head -n 1 || true)"
  if [ -n "$version_line" ]; then
    log "Pre-run: hivemoot CLI ready (${version_line})"
  else
    log "Pre-run: hivemoot CLI ready"
  fi
}

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
  local prompt_file="${AGENT_PROMPT_FILE:-/opt/hivemoot-agent/prompts/default.md}"
  local failures=0

  log "Pre-flight: validating configuration"

  # Provider CLI installed
  if ! command -v "$provider" >/dev/null 2>&1; then
    echo "Pre-flight: ${provider} CLI is not installed in the container." >&2
    failures=$((failures + 1))
  fi

  # Prompt file exists
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
  esac

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
  agent_home="${workspace_root}/homes/${agent_id}"
  wrapper_log="${agent_log_dir}/$(date '+%Y%m%d-%H%M%S')-${agent_id}-wrapper.log"

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

    # Preserve per-agent isolation while allowing subscription auth reuse:
    # copy shared provider home state once into each agent home.
    seed_provider_home "/home/node/.codex" "$agent_home/.codex"
    seed_provider_home "/home/node/.gemini" "$agent_home/.gemini"
    seed_provider_home "/home/node/.claude" "$agent_home/.claude"
    seed_provider_home "/home/node/.config/claude" "$agent_home/.config/claude"

    # Login shells (bash -lc) reset PATH from /etc/profile, losing the
    # Docker ENV that includes the npm global bin directory. Write a
    # .profile so agent subprocesses (codex/gemini/claude CLI tools)
    # can find hivemoot and other npm-installed binaries.
    # shellcheck disable=SC2016  # literal ${PATH} intended for .profile
    printf 'export PATH="/usr/local/share/npm-global/bin:${PATH}"\n' \
      > "$agent_home/.profile"

    unset AGENT_GITHUB_TOKEN GITHUB_TOKEN GH_TOKEN
    export HOME="$agent_home"
    export WORKSPACE_ROOT="$agent_workspace"
    export REPO_DIR="$agent_repo"
    export LOG_DIR="$agent_log_dir"
    export AGENT_GITHUB_TOKEN_FILE="$token_file"
    export AGENT_GIT_NAME="$agent_id"
    export AGENT_GIT_EMAIL="${agent_id}@${email_domain}"
    export HIVEMOOT_BUZZ_ROLE="$agent_id"
    export AGENT_EXTRA_PROMPT="$agent_extra_prompt"

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
