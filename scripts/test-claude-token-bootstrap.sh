#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_mode_600() {
  local path="$1"
  local mode=""
  if ! mode="$(stat -c '%a' "$path" 2>/dev/null)"; then
    mode="$(stat -f '%Lp' "$path")"
  fi
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
cleanup() {
  rm -rf "$tmp_home"
  rm -f "$tmp_stderr"
}
trap cleanup EXIT

# Entrypoint must bootstrap the Claude OAuth token files BEFORE it rejects
# the missing AGENT_PLUGINS — otherwise managed Claude auth could never be
# seeded in containers that rely on the bash entrypoint for pre-checks.
if env \
  HOME="$tmp_home" \
  CLAUDE_CODE_OAUTH_TOKEN='tok"en\slash' \
  bash scripts/entrypoint.sh > /dev/null 2> "$tmp_stderr"
then
  fail "entrypoint unexpectedly succeeded without AGENT_PLUGINS"
fi

grep -Fq "AGENT_PLUGINS is required" "$tmp_stderr" \
  || fail "expected AGENT_PLUGINS-required error"

[ -f "$tmp_home/.claude/.credentials.json" ] || fail "missing credentials file"
[ -f "$tmp_home/.claude.json" ] || fail "missing onboarding file"

assert_file_content_exact \
  "$tmp_home/.claude/.credentials.json" \
  '{"claudeAiOauth":{"accessToken":"tok\"en\\slash","expiresAt":4102444800000}}'

assert_file_content_exact \
  "$tmp_home/.claude.json" \
  '{"hasCompletedOnboarding":true}'

assert_file_mode_600 "$tmp_home/.claude/.credentials.json"
assert_file_mode_600 "$tmp_home/.claude.json"

echo "PASS: Claude token bootstrap checks"
