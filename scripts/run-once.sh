#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[run-once %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

resolve_role_prompt_block() {
  local role_name="$1"
  local repo_full_name="$2"
  local role_json_output=""
  local role_prompt_block=""

  if ! command -v hivemoot >/dev/null 2>&1; then
    echo "HIVEMOOT_BUZZ_ROLE is set but hivemoot CLI is not installed." >&2
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "HIVEMOOT_BUZZ_ROLE is set but node is not installed for JSON parsing." >&2
    return 1
  fi

  log "Resolving role config via hivemoot role for role=${role_name} repo=${repo_full_name}"
  if ! role_json_output="$(hivemoot role "$role_name" --repo "$repo_full_name" --json 2>&1)"; then
    echo "Failed to resolve role config. Provider launch aborted." >&2
    echo "$role_json_output" >&2
    return 1
  fi

  # shellcheck disable=SC2016  # single quotes intentional — JavaScript code, not shell
  if ! role_prompt_block="$(
    ROLE_JSON="$role_json_output" node -e '
const input = process.env.ROLE_JSON ?? "";
let parsed;
try {
  parsed = JSON.parse(input);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Invalid role JSON payload: ${message}`);
  process.exit(1);
}

const role = parsed && typeof parsed === "object" ? parsed.role : undefined;
if (!role || typeof role !== "object") {
  console.error("Invalid role JSON payload: missing role object");
  process.exit(1);
}
if (typeof role.name !== "string" || role.name.length === 0) {
  console.error("Invalid role JSON payload: missing role.name");
  process.exit(1);
}
if (typeof role.description !== "string") {
  console.error("Invalid role JSON payload: missing role.description");
  process.exit(1);
}
if (typeof role.instructions !== "string") {
  console.error("Invalid role JSON payload: missing role.instructions");
  process.exit(1);
}

const onboarding = typeof parsed.onboarding === "string" ? parsed.onboarding.replace(/\s+$/, "") : "";
const instructions = role.instructions.replace(/\s+$/, "");
const parts = [];
if (onboarding) {
  parts.push(`Team onboarding:\n${onboarding}`);
}
parts.push(`Your role on this project is: ${role.name}\nRole description: ${role.description}\nRole instructions: ${instructions}`);
process.stdout.write(parts.join("\n\n"));
')"; then
    echo "Failed to parse role config JSON. Provider launch aborted." >&2
    echo "$role_json_output" >&2
    return 1
  fi

  printf '%s' "$role_prompt_block"
}

_cleanup_files=()
# shellcheck disable=SC2317,SC2329  # invoked via trap
cleanup_once() {
  for f in "${_cleanup_files[@]-}"; do
    rm -f "$f" 2>/dev/null || true
  done
}
trap cleanup_once EXIT

required_cmds=(git gh)
for cmd in "${required_cmds[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"

load_secret_from_file AGENT_GITHUB_TOKEN
load_secret_from_file HIVEMOOT_AGENT_TOKEN
load_provider_secrets

# shellcheck source=scripts/opencode-helpers.sh
. "${SCRIPT_DIR}/opencode-helpers.sh"

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

  [ "$idle_age" -le $((max_idle_hours * 3600)) ] \
    && [ "$total_age" -le $((max_age_hours * 3600)) ]
}

provider="${AGENT_PROVIDER:-claude}"
auth_mode="${AGENT_AUTH_MODE:-auto}"
hivemoot_buzz_role="${HIVEMOOT_BUZZ_ROLE:-}"
target_repo="${TARGET_REPO:-}"
workspace_root="${WORKSPACE_ROOT:-/workspace}"
clone_depth="${GIT_CLONE_DEPTH:-50}"
prompt_file="${AGENT_PROMPT_FILE:-/opt/hivemoot-agent/prompts/system/autonomous.md}"
agent_skills="${AGENT_SKILLS:-}"
extra_prompt="${AGENT_EXTRA_PROMPT:-}"
agent_model="${AGENT_MODEL:-}"
agent_tool_options_json="${AGENT_TOOL_OPTIONS_JSON:-"{}"}"
timeout_secs="${AGENT_TIMEOUT_SECONDS:-1800}"
session_resume="${SESSION_RESUME:-${SESSION_RESUME_ENABLED:-1}}"
session_resume_max_idle_hours="${SESSION_RESUME_MAX_IDLE_HOURS:-12}"
session_resume_max_age_hours="${SESSION_RESUME_MAX_AGE_HOURS:-24}"
agent_git_name="${AGENT_GIT_NAME:-}"
agent_git_email="${AGENT_GIT_EMAIL:-}"
agent_session_key="${AGENT_SESSION_KEY:-}"
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

# When REPO_DIR/LOG_DIR are set externally (run-multi.sh, run-loop.sh),
# isolation is handled by the caller. Otherwise, generate a JOB_ID to
# namespace workspace/HOME/logs so every standalone run is isolated.
managed_mode=0
if [ -n "${REPO_DIR:-}" ] || [ -n "${LOG_DIR:-}" ]; then
  managed_mode=1
fi

job_id="${JOB_ID:-}"
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
provider_session_map_dir="${workspace_root}/sessions/${provider}"
provider_session_map_file="${provider_session_map_dir}/tool-session-map.tsv"

validate_target_repo "$target_repo"

github_token="${AGENT_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
if [ -z "$github_token" ]; then
  echo "Missing GitHub token. Set AGENT_GITHUB_TOKEN_FILE or AGENT_GITHUB_TOKEN (or GITHUB_TOKEN/GH_TOKEN)." >&2
  exit 1
fi

export GITHUB_TOKEN="$github_token"
export GH_TOKEN="$github_token"

github_login=""
if github_login_raw="$(gh api user --jq .login 2>/dev/null)"; then
  case "$github_login_raw" in
    ''|*[^a-zA-Z0-9-]*)
      github_login=""
      ;;
    *)
      github_login="$github_login_raw"
      ;;
  esac
fi
token_mode=""
if [ -n "$github_login" ]; then
  token_mode="user"
elif gh api installation --jq .id >/dev/null 2>&1; then
  token_mode="installation"
else
  echo "Failed to validate GitHub token. Ensure token is a valid user PAT/token or GitHub App installation token." >&2
  exit 1
fi

if ! gh api "repos/${target_repo}" --jq .full_name >/dev/null 2>&1; then
  echo "GitHub token cannot access target repository: ${target_repo}. Check token scope/installation access." >&2
  exit 1
fi

if ! gh auth setup-git 2>&1; then
  echo "Failed to configure git credential helper via gh auth setup-git" >&2
  exit 1
fi

if [ "$token_mode" = "user" ]; then
  agent_name="${agent_git_name:-$github_login}"
  agent_email="${agent_git_email:-${github_login}@users.noreply.github.com}"
else
  agent_name="${agent_git_name:-hivemoot-agent[bot]}"
  agent_email="${agent_git_email:-hivemoot-agent[bot]@users.noreply.github.com}"
fi

log "GitHub token mode detected: ${token_mode}"

mkdir -p "$workspace_root" "$log_dir"

# Create an isolated HOME for this job and seed only auth credentials
# (not conversation caches or session state). Skipped in managed mode
# where the caller (run-multi.sh / run-loop.sh) handles HOME isolation.
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

if [ ! -f "$prompt_file" ]; then
  echo "Prompt file not found: $prompt_file" >&2
  exit 1
fi

base_prompt_file=""
if base_prompt_file="$(resolve_companion_base_prompt "$prompt_file")"; then
  :
elif prompt_requires_companion_base "$prompt_file"; then
  echo "Base prompt file not found: $(dirname "$prompt_file")/base.md" >&2
  exit 1
fi

# Build system instructions separately from task context (extra_prompt). When
# a companion base prompt exists, prepend it to the mode-specific prompt;
# standalone custom prompts continue to work as a complete system prompt.
system_prompt="$(cat "$prompt_file")"
if [ -n "$base_prompt_file" ]; then
  system_prompt="$(cat "$base_prompt_file")

$(cat "$prompt_file")"
fi
if [ -n "$hivemoot_buzz_role" ]; then
  role_prompt_block=""
  if ! role_prompt_block="$(resolve_role_prompt_block "$hivemoot_buzz_role" "$target_repo")"; then
    exit 1
  fi

  system_prompt="${system_prompt}

${role_prompt_block}

Hivemoot buzz role: ${hivemoot_buzz_role}
Use this role value when running: hivemoot buzz --role ${hivemoot_buzz_role}
Target repository: ${target_repo}
Local repository path: ${repo_dir}
"
else
  system_prompt="${system_prompt}

Target repository: ${target_repo}
Local repository path: ${repo_dir}
"
fi

# Skill modules: capability blocks appended after the role context.
if [ -n "$agent_skills" ]; then
  skills_content=""
  if ! skills_content="$(load_skill_prompts "$agent_skills" "/opt/hivemoot-agent/skills")"; then
    exit 1
  fi
  if [ -n "$skills_content" ]; then
    system_prompt="${system_prompt}

<skills>
${skills_content}
</skills>"
  fi
fi

# Technical notes block: runtime details agents should be aware of.
# Append new notes here as the environment evolves.
technical_notes=""
if [ "$clone_depth" -gt 0 ]; then
  technical_notes="${technical_notes}
- Shallow clone (depth ${clone_depth}). git log/blame are truncated. Run \`git fetch --unshallow\` if you need full history."
fi

if [ -n "$technical_notes" ]; then
  system_prompt="${system_prompt}
Technical notes:
${technical_notes}
"
fi

# User message: mention context / extra instructions when present,
# otherwise a default directive.
default_user_message="Make meaningful contributions to the repository according to your role instructions."
if [ -n "$extra_prompt" ]; then
  user_message="$extra_prompt"
else
  user_message="$default_user_message"
fi

# Combined prompt for providers that don't support separate system/user split.
prompt="${system_prompt}

${user_message}"

resolve_remote_default_branch() {
  local dir="$1"
  local branch=""

  # Prefer origin/HEAD (set by clone or remote set-head)
  if branch="$(git -C "$dir" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)"; then
    branch="${branch#refs/remotes/origin/}"
    if [ -n "$branch" ]; then
      printf '%s' "$branch"
      return 0
    fi
  fi

  # Fallback: try well-known defaults
  local candidate
  for candidate in main master; do
    if git -C "$dir" rev-parse --verify "origin/${candidate}" >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  # Last resort: first remote branch
  branch="$(git -C "$dir" branch -r --format='%(refname:short)' 2>/dev/null \
    | sed -n 's|^origin/||p' | grep -v '^HEAD$' | head -n 1)"
  if [ -n "$branch" ]; then
    printf '%s' "$branch"
    return 0
  fi

  return 1
}

clone_repo() {
  local askpass
  askpass="$(mktemp)"
  _cleanup_files+=("$askpass")
  cat > "$askpass" <<'EOF'
#!/usr/bin/env sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "${GIT_PAT:-}" ;;
  *) echo "" ;;
esac
EOF
  chmod 700 "$askpass"

  # Try to sync an existing checkout; on any failure, delete and reclone.
  local sync_ok=0
  if [ -d "$repo_dir/.git" ]; then
    log "Reusing existing clone: ${repo_dir}"
    local default_branch=""
    if default_branch="$(resolve_remote_default_branch "$repo_dir")"; then
      log "Updating to origin/${default_branch}"
      if git -C "$repo_dir" fetch --prune origin 2>&1 \
        && git -C "$repo_dir" reset --hard "origin/${default_branch}" 2>&1 \
        && git -C "$repo_dir" clean -fdx 2>&1; then
        sync_ok=1
      else
        log "Sync failed; deleting stale checkout and recloning"
      fi
    else
      log "Could not determine default branch; deleting stale checkout and recloning"
    fi

    if [ "$sync_ok" -eq 0 ]; then
      rm -rf "$repo_dir"
    fi
  fi

  if [ ! -d "$repo_dir/.git" ]; then
    local clone_args=(--single-branch)
    local depth_label="full"
    if [ "$clone_depth" -gt 0 ]; then
      clone_args+=(--depth "$clone_depth")
      depth_label="$clone_depth"
    fi
    log "Cloning https://github.com/${target_repo}.git (depth=${depth_label})"
    if ! GIT_ASKPASS="$askpass" GIT_PAT="$github_token" GIT_TERMINAL_PROMPT=0 \
      git clone "${clone_args[@]}" "https://github.com/${target_repo}.git" "$repo_dir" 2>&1; then
      rm -rf "$repo_dir"
      rm -f "$askpass"
      echo "Failed to clone ${target_repo}. Check token and repo access." >&2
      exit 1
    fi
  fi

  rm -f "$askpass"

  git -C "$repo_dir" config user.name "$agent_name"
  git -C "$repo_dir" config user.email "$agent_email"
}

clone_repo

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
        "$session_resume_max_idle_hours" "$session_resume_max_age_hours"; then
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

You are resuming a prior session for this mention thread. Some data in your context may be stale — refresh the relevant information before acting."
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

    # In task mode, use text output format so the log IS the answer text.
    # Remove --verbose to keep stdout clean (verbose lines would pollute the
    # extracted result). Keep stream-json + verbose for non-task runs where
    # structured events enable session resume and telemetry.
    if [ -n "${AGENT_TASK_ID:-}" ]; then
      claude_fresh_cmd=(claude -p --output-format text --dangerously-skip-permissions)
    else
      claude_fresh_cmd=(claude -p --verbose --output-format stream-json --dangerously-skip-permissions)
    fi
    claude_fresh_cmd+=(--append-system-prompt "$system_prompt")
    if [ -n "$agent_model" ]; then
      claude_fresh_cmd+=(--model "$agent_model")
    fi
    claude_fresh_cmd+=("$user_message")

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
        "$session_resume_max_idle_hours" "$session_resume_max_age_hours"; then
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

You are resuming a prior session for this mention thread. Some data in your context may be stale — refresh the relevant information before acting."
      if [ -n "${AGENT_TASK_ID:-}" ]; then
        cmd=(claude --resume "$claude_active_session_id" -p --output-format text --dangerously-skip-permissions)
      else
        cmd=(claude --resume "$claude_active_session_id" -p --verbose --output-format stream-json --dangerously-skip-permissions)
      fi
      cmd+=(--append-system-prompt "$system_prompt")
      if [ -n "$agent_model" ]; then
        cmd+=(--model "$agent_model")
      fi
      cmd+=("$claude_resume_user_message")
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
# shellcheck source=scripts/health-reporter.sh
. "${SCRIPT_DIR}/health-reporter.sh"

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
  _next_run_at=""
  if [ -n "${PERIODIC_INTERVAL_SECS:-}" ] && printf '%s' "$PERIODIC_INTERVAL_SECS" | grep -Eq '^[1-9][0-9]*$'; then
    _next_run_at="$(date -u -d "+${PERIODIC_INTERVAL_SECS} seconds" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
      || date -u -v "+${PERIODIC_INTERVAL_SECS}S" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
      || true)"
  fi

  report_health_to_backend \
    "$agent_name" "$target_repo" "${HIVEMOOT_AGENT_TOKEN:-}" \
    "$run_id" "$_run_outcome" "$run_duration_secs" "${_consecutive_failures:-0}" \
    "$exit_code" "${_run_error:-}" "$_next_run_at" || true
fi

if [ -n "${last_command_log:-}" ] && [ "$last_command_log" != "$log_file" ] && [ -f "$last_command_log" ]; then
  rm -f "$last_command_log"
fi

log "Run finished with exit_code=${exit_code}. Log: ${log_file}"
exit "$exit_code"
