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

# Regression: leading-dot owner components allow path traversal in filesystem
# path construction (e.g. ${cache}/../evil → parent dir). The owner segment
# must start with an alphanumeric character.
assert_fails_with \
  "Invalid TARGET_REPO: ../evil. Expected owner/repo." \
  env TARGET_REPO=../evil bash scripts/run-once.sh

# Regression: bare . and .. as the repo segment are rejected; they would
# resolve to the current or parent directory in path construction.
assert_fails_with \
  "Invalid TARGET_REPO: owner/.. Expected owner/repo." \
  env TARGET_REPO=owner/. bash scripts/run-once.sh

assert_fails_with \
  "Invalid TARGET_REPO: owner/... Expected owner/repo." \
  env TARGET_REPO=owner/.. bash scripts/run-once.sh

echo "PASS: TARGET_REPO validation checks"
