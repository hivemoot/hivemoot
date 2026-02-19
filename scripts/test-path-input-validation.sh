#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
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

echo "Running workspace root and agent ID validation checks"

assert_fails_with \
  "WORKSPACE_ROOT must be an absolute path" \
  env TARGET_REPO=owner/repo WORKSPACE_ROOT=relative bash scripts/run-once.sh

assert_fails_with \
  "WORKSPACE_ROOT must be an absolute path" \
  env TARGET_REPO=owner/repo WORKSPACE_ROOT=relative AGENT_ID_01=worker AGENT_GITHUB_TOKEN_01=dummy bash scripts/run-multi.sh

assert_fails_with \
  "WORKSPACE_ROOT must be an absolute path" \
  env TARGET_REPO=owner/repo WORKSPACE_ROOT=relative AGENT_ID_01=worker AGENT_GITHUB_TOKEN_01=dummy bash scripts/run-loop.sh

assert_fails_with \
  "Invalid agent id: ." \
  env TARGET_REPO=owner/repo AGENT_ID_01=. AGENT_GITHUB_TOKEN_01=dummy bash scripts/run-multi.sh

assert_fails_with \
  "Invalid agent id: ." \
  env TARGET_REPO=owner/repo AGENT_ID_01=. AGENT_GITHUB_TOKEN_01=dummy bash scripts/run-loop.sh

assert_fails_with \
  "Invalid agent id: .." \
  env TARGET_REPO=owner/repo AGENT_ID_01=.. AGENT_GITHUB_TOKEN_01=dummy bash scripts/run-multi.sh

assert_fails_with \
  "Invalid agent id: .." \
  env TARGET_REPO=owner/repo AGENT_ID_01=.. AGENT_GITHUB_TOKEN_01=dummy bash scripts/run-loop.sh

echo "PASS: workspace root and agent ID validation checks"
