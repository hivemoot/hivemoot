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

echo "Running TARGET_REPO validation checks"

assert_fails_with \
  "TARGET_REPO is required. Set it as owner/repo." \
  env -u TARGET_REPO bash scripts/run-once.sh

assert_fails_with \
  "Invalid TARGET_REPO: not-a-repo. Expected owner/repo." \
  env TARGET_REPO=not-a-repo bash scripts/run-once.sh

assert_fails_with \
  "TARGET_REPO is required. Set it as owner/repo." \
  env -u TARGET_REPO bash scripts/run-multi.sh

assert_fails_with \
  "Invalid TARGET_REPO: not-a-repo. Expected owner/repo." \
  env TARGET_REPO=not-a-repo bash scripts/run-multi.sh

assert_fails_with \
  "TARGET_REPO is required. Set it as owner/repo." \
  env -u TARGET_REPO -u WATCH_MENTIONS bash scripts/run-loop.sh

assert_fails_with \
  "Invalid TARGET_REPO: not-a-repo. Expected owner/repo." \
  env -u WATCH_MENTIONS TARGET_REPO=not-a-repo bash scripts/run-loop.sh

echo "PASS: TARGET_REPO validation checks"
