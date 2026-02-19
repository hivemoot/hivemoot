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

assert_fails_with() {
  local expected="$1"
  shift

  local stderr_file
  stderr_file="$(mktemp)"

  if "$@" > /dev/null 2> "$stderr_file"; then
    rm -f "$stderr_file"
    fail "command succeeded unexpectedly: $*"
  fi

  if ! grep -Fqx "$expected" "$stderr_file"; then
    echo "Expected stderr line:" >&2
    echo "  $expected" >&2
    echo "Actual stderr:" >&2
    sed 's/^/  /' "$stderr_file" >&2
    rm -f "$stderr_file"
    fail "stderr mismatch for: $*"
  fi

  rm -f "$stderr_file"
}

echo "Running auto-auth file-secret checks"

# shellcheck source=scripts/lib.sh
. scripts/lib.sh

tmp_key_file="$(mktemp)"
missing_key_file="/tmp/hivemoot-missing-openai-key-$$"

cleanup() {
  rm -f "$tmp_key_file"
}
trap cleanup EXIT

printf '%s' "sk-test-from-file" > "$tmp_key_file"
unset OPENAI_API_KEY || true
export OPENAI_API_KEY_FILE="$tmp_key_file"
load_secret_from_file OPENAI_API_KEY
assert_eq "api_key" "$(resolve_effective_auth_mode "codex" "auto")" \
  "codex auto should resolve to api_key after *_FILE load"
unset OPENAI_API_KEY OPENAI_API_KEY_FILE || true

# These wrappers should load *_FILE secrets before resolving auth mode
# or parsing agents. A missing file must fail fast with the file error.
rm -f "$missing_key_file"

assert_fails_with \
  "OPENAI_API_KEY_FILE is set but file does not exist: ${missing_key_file}" \
  env \
    AGENT_PROVIDER=codex \
    AGENT_AUTH_MODE=auto \
    OPENAI_API_KEY= \
    OPENAI_API_KEY_FILE="${missing_key_file}" \
    TARGET_REPO=owner/repo \
    AGENT_ID_01=worker \
    AGENT_GITHUB_TOKEN_01=dummy \
    bash scripts/run-multi.sh

assert_fails_with \
  "OPENAI_API_KEY_FILE is set but file does not exist: ${missing_key_file}" \
  env \
    AGENT_PROVIDER=codex \
    AGENT_AUTH_MODE=auto \
    OPENAI_API_KEY= \
    OPENAI_API_KEY_FILE="${missing_key_file}" \
    TARGET_REPO=owner/repo \
    AGENT_ID_01=worker \
    AGENT_GITHUB_TOKEN_01=dummy \
    bash scripts/run-loop.sh

echo "PASS: auto-auth file-secret checks"
