#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [ "$expected" != "$actual" ]; then
    fail "${message} (expected='${expected}' actual='${actual}')"
  fi
}

assert_not_workspace_path() {
  local path="$1"
  local message="$2"
  if printf '%s' "$path" | grep -Eq '^/workspace/'; then
    fail "${message}: ${path}"
  fi
}

assert_workspace_path() {
  local path="$1"
  local message="$2"
  if ! printf '%s' "$path" | grep -Eq '^/workspace/'; then
    fail "${message}: ${path}"
  fi
}

echo "Running credential storage mode checks"

# shellcheck source=scripts/lib.sh
. scripts/lib.sh
# shellcheck source=scripts/opencode-helpers.sh
. scripts/opencode-helpers.sh

OPENAI_API_KEY=""
assert_eq "subscription" "$(resolve_effective_auth_mode "codex" "auto")" "codex auto resolves to subscription without API key"
OPENAI_API_KEY="dummy"
assert_eq "api_key" "$(resolve_effective_auth_mode "codex" "auto")" "codex auto resolves to api_key with API key"
unset OPENAI_API_KEY

ANTHROPIC_API_KEY=""
assert_eq "subscription" "$(resolve_effective_auth_mode "claude" "auto")" "claude auto resolves to subscription without API key"
ANTHROPIC_API_KEY="dummy"
assert_eq "api_key" "$(resolve_effective_auth_mode "claude" "auto")" "claude auto resolves to api_key with API key"
unset ANTHROPIC_API_KEY

assert_eq "api_key" "$(resolve_effective_auth_mode "codex" "api_key")" "explicit api_key mode"
assert_eq "subscription" "$(resolve_effective_auth_mode "codex" "subscription")" "explicit subscription mode"
if resolve_effective_auth_mode "codex" "invalid" >/dev/null 2>&1; then
  fail "resolve_effective_auth_mode accepted invalid mode"
fi

assert_eq \
  "/workspace/repo/run-123/home" \
  "$(resolve_job_home "/workspace/repo" "run-123" "subscription")" \
  "subscription run-once HOME path"
assert_eq \
  "/workspace/repo/homes/worker" \
  "$(resolve_managed_agent_home "/workspace/repo" "worker" "subscription")" \
  "subscription managed HOME path"

api_key_job_home="$(resolve_job_home "/workspace/repo" "run-123" "api_key")"
api_key_agent_home="$(resolve_managed_agent_home "/workspace/repo" "worker" "api_key")"

assert_not_workspace_path "$api_key_job_home" "api_key run-once HOME must be outside /workspace"
assert_not_workspace_path "$api_key_agent_home" "api_key managed HOME must be outside /workspace"
assert_workspace_path "$(resolve_job_home "/workspace/repo" "run-123" "subscription")" "subscription run-once HOME must stay under /workspace"

# Ensure auth seeding still works with api_key-mode HOME roots.
tmp_source_home="$(mktemp -d)"
test_suffix="test-$$"
api_key_job_home="$(resolve_job_home "/workspace/repo" "$test_suffix" "api_key")"
api_key_agent_home="$(resolve_managed_agent_home "/workspace/repo" "$test_suffix" "api_key")"
cleanup() {
  rm -rf "$tmp_source_home"
  rm -rf "$api_key_job_home"
  rm -rf "$api_key_agent_home"
}
trap cleanup EXIT

mkdir -p "$tmp_source_home/.claude" "$tmp_source_home/.config/claude"
printf '%s' '{"claudeAiOauth":{"accessToken":"api-key-mode-token","expiresAt":4102444800000}}' \
  > "$tmp_source_home/.claude/.credentials.json"
printf '%s' '{"hasCompletedOnboarding":true}' \
  > "$tmp_source_home/.claude.json"
printf '%s' '{"foo":"bar"}' > "$tmp_source_home/.config/claude/settings.json"

AGENT_PROVIDER=claude
seed_provider_auth "$api_key_job_home" "$tmp_source_home"
seed_shared_provider_state "$api_key_agent_home" "$tmp_source_home"

[ -f "$api_key_job_home/.claude/.credentials.json" ] \
  || fail "run-once auth seeding missing credentials in api_key HOME"
[ -f "$api_key_agent_home/.claude/.credentials.json" ] \
  || fail "managed auth seeding missing credentials in api_key HOME"
[ -f "$api_key_agent_home/.claude.json" ] \
  || fail "managed auth seeding missing onboarding file in api_key HOME"

echo "PASS: Credential storage mode checks"
