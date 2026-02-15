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

required_cmds=(git gh)
for cmd in "${required_cmds[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

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
  AGENT_GITHUB_TOKEN \
  OPENAI_API_KEY \
  GOOGLE_API_KEY \
  GEMINI_API_KEY \
  ANTHROPIC_API_KEY
do
  load_secret_from_file "$secret_var"
done

provider="${AGENT_PROVIDER:-claude}"
auth_mode="${AGENT_AUTH_MODE:-auto}"
hivemoot_buzz_role="${HIVEMOOT_BUZZ_ROLE:-}"
target_repo="${TARGET_REPO:-}"
workspace_root="${WORKSPACE_ROOT:-/workspace}"
repo_dir="${REPO_DIR:-${workspace_root}/repo}"
log_dir="${LOG_DIR:-${workspace_root}/runs}"
fresh_clone="${FRESH_CLONE:-1}"
prompt_file="${AGENT_PROMPT_FILE:-/opt/hivemoot-agent/prompts/default.md}"
extra_prompt="${AGENT_EXTRA_PROMPT:-}"
agent_model="${AGENT_MODEL:-}"
timeout_secs="${AGENT_TIMEOUT_SECONDS:-1800}"
agent_git_name="${AGENT_GIT_NAME:-}"
agent_git_email="${AGENT_GIT_EMAIL:-}"

case "$auth_mode" in
  auto|api_key|subscription) ;;
  *)
    echo "Unsupported AGENT_AUTH_MODE: ${auth_mode}. Use auto|api_key|subscription." >&2
    exit 1
    ;;
esac

if [ -z "$target_repo" ]; then
  echo "TARGET_REPO is required. Set it as owner/repo." >&2
  exit 1
fi
if ! printf '%s' "$target_repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "Invalid TARGET_REPO: ${target_repo}. Expected owner/repo." >&2
  exit 1
fi

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

if [ ! -f "$prompt_file" ]; then
  echo "Prompt file not found: $prompt_file" >&2
  exit 1
fi

# Build system instructions (base prompt + role) separately from task context
# (extra_prompt). Claude uses --append-system-prompt for the former and the
# user message for the latter; other providers concatenate everything.
system_prompt="$(cat "$prompt_file")"
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

clone_repo() {
  local askpass
  askpass="$(mktemp)"
  cat > "$askpass" <<'EOF'
#!/usr/bin/env sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "${GIT_PAT:-}" ;;
  *) echo "" ;;
esac
EOF
  chmod 700 "$askpass"

  if [ "$fresh_clone" = "1" ] && [ -d "$repo_dir" ]; then
    log "Removing previous clone: ${repo_dir}"
    rm -rf "$repo_dir"
  fi

  if [ ! -d "$repo_dir/.git" ]; then
    log "Cloning https://github.com/${target_repo}.git"
    if ! GIT_ASKPASS="$askpass" GIT_PAT="$github_token" GIT_TERMINAL_PROMPT=0 \
      git clone "https://github.com/${target_repo}.git" "$repo_dir" >/dev/null 2>&1; then
      rm -rf "$repo_dir"
      rm -f "$askpass"
      echo "Failed to clone ${target_repo}. Check token and repo access." >&2
      exit 1
    fi
  else
    log "Reusing existing clone: ${repo_dir}"
  fi

  rm -f "$askpass"

  git -C "$repo_dir" config user.name "$agent_name"
  git -C "$repo_dir" config user.email "$agent_email"
}

clone_repo

safe_agent_name="$(printf '%s' "$agent_name" | tr -c '[:alnum:]._-' '_')"
run_id="$(date '+%Y%m%d-%H%M%S')-${provider}-${safe_agent_name}"
log_file="${log_dir}/${run_id}.log"

cmd=()
run_in_repo=0
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
        echo "Codex subscription login not found. Run: docker compose run --rm auth-codex" >&2
        exit 1
      fi
    fi

    cmd=(codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd "$repo_dir" --json)
    if [ -n "$agent_model" ]; then
      cmd+=(--model "$agent_model")
    fi
    cmd+=("$prompt")
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

    cmd=(gemini --yolo --output-format stream-json -p "$prompt")
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
      if [ ! -d "${HOME}/.claude" ] && [ ! -d "${HOME}/.config/claude" ]; then
        echo "Claude subscription credentials not found. Run: docker compose run --rm auth-claude" >&2
        exit 1
      fi
      log "Using Claude subscription/cached auth (no API key required)"
    fi
    log "Claude auth mode resolved to: ${claude_auth_mode}"

    cmd=(claude -p --verbose --output-format stream-json --dangerously-skip-permissions)
    cmd+=(--append-system-prompt "$system_prompt")
    if [ -n "$agent_model" ]; then
      cmd+=(--model "$agent_model")
    fi
    cmd+=("$user_message")
    run_in_repo=1
    ;;

  *)
    echo "Unsupported AGENT_PROVIDER: ${provider}. Use codex|gemini|claude." >&2
    exit 1
    ;;
esac

log "Starting provider=${provider} auth_mode=${auth_mode} repo=${target_repo}"
# Capture exit code via temp file instead of PIPESTATUS so the tee pipe
# cannot silently swallow the command's real exit code.
_ec_file="$(mktemp)"
set +e
if [ "$run_in_repo" = "1" ]; then
  if command -v timeout >/dev/null 2>&1; then
    (cd "$repo_dir" && timeout "$timeout_secs" "${cmd[@]}"; printf '%d' "$?" > "$_ec_file") 2>&1 | tee "$log_file"
  else
    (cd "$repo_dir" && "${cmd[@]}"; printf '%d' "$?" > "$_ec_file") 2>&1 | tee "$log_file"
  fi
else
  if command -v timeout >/dev/null 2>&1; then
    (timeout "$timeout_secs" "${cmd[@]}"; printf '%d' "$?" > "$_ec_file") 2>&1 | tee "$log_file"
  else
    ("${cmd[@]}"; printf '%d' "$?" > "$_ec_file") 2>&1 | tee "$log_file"
  fi
fi
exit_code="$(cat "$_ec_file")"
rm -f "$_ec_file"
set -e

if [ "$exit_code" -eq 124 ]; then
  log "Run timed out after ${timeout_secs}s"
fi

log "Run finished with exit_code=${exit_code}. Log: ${log_file}"
exit "$exit_code"
