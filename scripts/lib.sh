#!/usr/bin/env bash
set -euo pipefail

# lib.sh is a sourced library; avoid "return" errors when run directly.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  echo "scripts/lib.sh is a library and should be sourced, not executed." >&2
  exit 0
fi

if [ -n "${HIVEMOOT_LIB_LOADED:-}" ]; then
  return 0
fi
HIVEMOOT_LIB_LOADED=1

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

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

validate_target_repo() {
  local target_repo="$1"

  if [ -z "$target_repo" ]; then
    echo "TARGET_REPO is required. Set it as owner/repo." >&2
    exit 1
  fi

  if ! printf '%s' "$target_repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    echo "Invalid TARGET_REPO: ${target_repo}. Expected owner/repo." >&2
    exit 1
  fi
}

validate_workspace_root() {
  local workspace_root="$1"

  case "$workspace_root" in
    /*) ;;
    *)
      echo "WORKSPACE_ROOT must be an absolute path" >&2
      exit 1
      ;;
  esac
}

validate_agent_id() {
  local agent_id="$1"

  case "$agent_id" in
    ''|*[!a-zA-Z0-9_-]*)
      echo "Invalid agent id: ${agent_id}" >&2
      exit 1
      ;;
  esac
}

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

# Managed-mode seeding: copy shared provider state into each isolated
# agent home. This intentionally mirrors directory-level provider data.
seed_shared_provider_state() {
  local agent_home="$1"
  local source_home="${2:-/home/node}"

  seed_provider_home "${source_home}/.codex" "${agent_home}/.codex"
  seed_provider_home "${source_home}/.gemini" "${agent_home}/.gemini"
  seed_provider_home "${source_home}/.claude" "${agent_home}/.claude"
  seed_provider_home "${source_home}/.claude.json" "${agent_home}/.claude.json"
  seed_provider_home "${source_home}/.config/claude" "${agent_home}/.config/claude"
  seed_provider_home "${source_home}/.config/kilo" "${agent_home}/.config/kilo"
  seed_provider_home "${source_home}/.config/opencode" "${agent_home}/.config/opencode"
  seed_provider_home "${source_home}/.local/share/opencode" "${agent_home}/.local/share/opencode"
}

# Selective auth seeding: copy only credential files for a provider,
# skipping conversation caches and session state. Use this instead of
# seed_provider_home when JOB_ID isolation is active.
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
  if [ -f "${source_home}/.claude.json" ]; then
    cp "${source_home}/.claude.json" "${agent_home}/.claude.json"
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

  # Kilo: config directory holds provider auth and permission settings
  if [ -d "${source_home}/.config/kilo" ]; then
    mkdir -p "${agent_home}/.config/kilo"
    cp -R "${source_home}/.config/kilo"/. "${agent_home}/.config/kilo"/
  fi

  # OpenCode: config directory holds provider auth and permission settings
  if [ -d "${source_home}/.config/opencode" ]; then
    mkdir -p "${agent_home}/.config/opencode"
    cp -R "${source_home}/.config/opencode"/. "${agent_home}/.config/opencode"/
  fi
  # OpenCode: auth credentials from ~/.local/share/opencode/
  if [ -f "${source_home}/.local/share/opencode/auth.json" ]; then
    mkdir -p "${agent_home}/.local/share/opencode"
    cp "${source_home}/.local/share/opencode/auth.json" "${agent_home}/.local/share/opencode/auth.json"
  fi

  # OpenCode: auto-generate config and auth.json if missing
  generate_opencode_config "$agent_home"
}
