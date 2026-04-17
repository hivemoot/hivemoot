#!/usr/bin/env bash
set -euo pipefail

# Unit checks for validate_target_repo() in shared/lib.sh. The controller
# calls this before enqueuing jobs and the worker entrypoint re-validates
# inside prepare_plugin_engine_dispatch(); both paths rely on the same
# implementation here.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_fails_with() {
  local expected="$1"
  local candidate="$2"
  local label="${candidate:-<empty>}"

  local stderr_file
  stderr_file="$(mktemp)"
  if (
    # shellcheck source=shared/lib.sh
    . "${repo_root}/shared/lib.sh"
    validate_target_repo "$candidate"
  ) > /dev/null 2> "$stderr_file"; then
    rm -f "$stderr_file"
    fail "validate_target_repo unexpectedly accepted: ${label}"
  fi

  if ! grep -Fqx "$expected" "$stderr_file"; then
    echo "Expected stderr line:" >&2
    echo "  $expected" >&2
    echo "Actual stderr:" >&2
    sed 's/^/  /' "$stderr_file" >&2
    rm -f "$stderr_file"
    fail "stderr mismatch for TARGET_REPO=${label}"
  fi

  rm -f "$stderr_file"
}

echo "Running TARGET_REPO validation checks"

assert_fails_with \
  "TARGET_REPO is required. Set it as owner/repo." \
  ""

assert_fails_with \
  "Invalid TARGET_REPO: not-a-repo. Expected owner/repo." \
  "not-a-repo"

# Regression: leading-dot owner components allow path traversal in filesystem
# path construction (e.g. ${cache}/../evil → parent dir). The owner segment
# must start with an alphanumeric character.
assert_fails_with \
  "Invalid TARGET_REPO: ../evil. Expected owner/repo." \
  "../evil"

# Regression: bare . and .. as the repo segment are rejected; they would
# resolve to the current or parent directory in path construction.
assert_fails_with \
  "Invalid TARGET_REPO: owner/.. Expected owner/repo." \
  "owner/."

assert_fails_with \
  "Invalid TARGET_REPO: owner/... Expected owner/repo." \
  "owner/.."

echo "PASS: TARGET_REPO validation checks"
