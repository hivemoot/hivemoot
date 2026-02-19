#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_mode_600() {
  local path="$1"
  local mode
  mode="$(stat -c '%a' "$path")"
  [ "$mode" = "600" ] || fail "expected mode 600 for $path, got $mode"
}

assert_file_content_exact() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(cat "$path")"
  [ "$actual" = "$expected" ] || fail "unexpected content in $path: $actual"
}

echo "Running Claude token bootstrap checks"

tmp_home="$(mktemp -d)"
tmp_stderr="$(mktemp)"
tmp_shared_home="$(mktemp -d)"
tmp_agent_home="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_home"
  rm -rf "$tmp_shared_home"
  rm -rf "$tmp_agent_home"
  rm -f "$tmp_stderr"
}
trap cleanup EXIT

if env \
  HOME="$tmp_home" \
  CLAUDE_CODE_OAUTH_TOKEN="token-from-env" \
  RUN_MODE="invalid" \
  bash scripts/entrypoint.sh > /dev/null 2> "$tmp_stderr"
then
  fail "entrypoint unexpectedly succeeded with invalid RUN_MODE"
fi

grep -Fqx "Invalid RUN_MODE: invalid. Expected: once|loop" "$tmp_stderr" \
  || fail "expected invalid RUN_MODE error"

[ -f "$tmp_home/.claude/.credentials.json" ] || fail "missing credentials file"
[ -f "$tmp_home/.claude.json" ] || fail "missing onboarding file"

assert_file_content_exact \
  "$tmp_home/.claude/.credentials.json" \
  '{"claudeAiOauth":{"accessToken":"token-from-env","expiresAt":4102444800000}}'

assert_file_content_exact \
  "$tmp_home/.claude.json" \
  '{"hasCompletedOnboarding":true}'

assert_file_mode_600 "$tmp_home/.claude/.credentials.json"
assert_file_mode_600 "$tmp_home/.claude.json"

# Managed-mode seeding must propagate both Claude auth files.
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

mkdir -p "$tmp_shared_home/.claude"
printf '%s' '{"claudeAiOauth":{"accessToken":"managed-token","expiresAt":4102444800000}}' \
  > "$tmp_shared_home/.claude/.credentials.json"
printf '%s' '{"hasCompletedOnboarding":true}' > "$tmp_shared_home/.claude.json"

seed_shared_provider_state "$tmp_agent_home" "$tmp_shared_home"

[ -f "$tmp_agent_home/.claude/.credentials.json" ] || fail "managed mode missing credentials file"
[ -f "$tmp_agent_home/.claude.json" ] || fail "managed mode missing onboarding file"

assert_file_content_exact \
  "$tmp_agent_home/.claude/.credentials.json" \
  '{"claudeAiOauth":{"accessToken":"managed-token","expiresAt":4102444800000}}'
assert_file_content_exact \
  "$tmp_agent_home/.claude.json" \
  '{"hasCompletedOnboarding":true}'

echo "PASS: Claude token bootstrap checks"
