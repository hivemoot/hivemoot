#!/usr/bin/env bash
# shellcheck disable=SC2154  # target_repo/repo_dir/clone_depth are supplied by the sourced runtime context.
# GitHub integration — auth, clone, and git configuration.
#
# Source this file to get: github_check_deps, github_auth,
# github_clone_or_sync, github_configure_git.
#
# After github_auth: github_token, github_login, token_mode are set.
#   agent_name / agent_email are updated from GitHub context when the
#   caller has not set AGENT_GIT_NAME / AGENT_GIT_EMAIL explicitly.
# After github_configure_git: git user.name/email configured in repo_dir.

[ -n "${HIVEMOOT_INTEGRATION_GITHUB_SETUP_LOADED:-}" ] && return 0
HIVEMOOT_INTEGRATION_GITHUB_SETUP_LOADED=1

github_check_deps() {
  local cmds=(git gh)
  for cmd in "${cmds[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "GitHub integration: missing required command: $cmd" >&2
      return 1
    fi
  done
}

github_auth() {
  validate_target_repo "$target_repo"

  github_token="${AGENT_GITHUB_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
  if [ -z "$github_token" ]; then
    echo "GitHub integration: missing token. Set AGENT_GITHUB_TOKEN_FILE or AGENT_GITHUB_TOKEN." >&2
    return 1
  fi

  export GITHUB_TOKEN="$github_token"
  export GH_TOKEN="$github_token"

  github_login=""
  local github_login_raw=""
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
    echo "GitHub integration: failed to validate token." >&2
    return 1
  fi

  if ! gh api "repos/${target_repo}" --jq .full_name >/dev/null 2>&1; then
    echo "GitHub integration: token cannot access ${target_repo}." >&2
    return 1
  fi

  if ! gh auth setup-git 2>&1; then
    echo "GitHub integration: gh auth setup-git failed." >&2
    return 1
  fi

  # Derive agent name/email from GitHub context when not explicitly set.
  # identity_resolve() sets defaults from AGENT_GIT_NAME / AGENT_ID;
  # here we refine with the authenticated GitHub identity.
  if [ -z "${AGENT_GIT_NAME:-}" ]; then
    if [ "$token_mode" = "user" ] && [ -n "$github_login" ]; then
      agent_name="$github_login"
    elif [ "$token_mode" = "installation" ]; then
      agent_name="${agent_name:-hivemoot-agent[bot]}"
    fi
  fi
  if [ -z "${AGENT_GIT_EMAIL:-}" ]; then
    if [ "$token_mode" = "user" ] && [ -n "$github_login" ]; then
      agent_email="${github_login}@users.noreply.github.com"
    else
      agent_email="${agent_name}@users.noreply.github.com"
    fi
  fi

  log "GitHub token mode: ${token_mode}"
}

github_configure_git() {
  git -C "$repo_dir" config user.name "$agent_name"
  git -C "$repo_dir" config user.email "$agent_email"
}

_github_resolve_default_branch() {
  local dir="$1"
  local branch=""

  if branch="$(git -C "$dir" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null)"; then
    branch="${branch#refs/remotes/origin/}"
    if [ -n "$branch" ]; then
      printf '%s' "$branch"
      return 0
    fi
  fi

  local candidate
  for candidate in main master; do
    if git -C "$dir" rev-parse --verify "origin/${candidate}" >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  branch="$(git -C "$dir" branch -r --format='%(refname:short)' 2>/dev/null \
    | sed -n 's|^origin/||p' | grep -v '^HEAD$' | head -n 1)"
  if [ -n "$branch" ]; then
    printf '%s' "$branch"
    return 0
  fi

  return 1
}

github_clone_or_sync() {
  local askpass
  askpass="$(mktemp)"
  _cleanup_files+=("$askpass")
  cat > "$askpass" <<'ASKPASS'
#!/usr/bin/env sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "${GIT_PAT:-}" ;;
  *) echo "" ;;
esac
ASKPASS
  chmod 700 "$askpass"

  local sync_ok=0
  if [ -d "$repo_dir/.git" ]; then
    log "Reusing existing clone: ${repo_dir}"
    local default_branch=""
    if default_branch="$(_github_resolve_default_branch "$repo_dir")"; then
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
      echo "GitHub integration: failed to clone ${target_repo}." >&2
      return 1
    fi
  fi

  rm -f "$askpass"
}
