#!/usr/bin/env bash
set -euo pipefail

# Unit checks for the path/ID validators in shared/lib.sh. Production
# callers live in controller/main.sh (host-side) and worker/entrypoint.sh
# (container-side); this script exercises the helpers directly.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1090
. "${repo_root}/shared/lib.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_fails_with() {
  local expected="$1"
  shift

  local stderr_file
  stderr_file="$(mktemp)"
  if ( "$@" ) > /dev/null 2> "$stderr_file"; then
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

echo "Running workspace root validation checks"

assert_fails_with \
  "WORKSPACE_ROOT must be an absolute path" \
  validate_workspace_root "relative"

echo "PASS: workspace root validation checks"

echo "Running AGENT_ID validation checks"

assert_fails_with \
  "Invalid AGENT_ID: ." \
  validate_agent_id "."

assert_fails_with \
  "Invalid AGENT_ID: .." \
  validate_agent_id ".."

echo "PASS: AGENT_ID validation checks"

echo "Running require_non_negative_integer() checks"

assert_fails_with \
  "GIT_CLONE_DEPTH must be a non-negative integer" \
  require_non_negative_integer "GIT_CLONE_DEPTH" "abc"

assert_fails_with \
  "GIT_CLONE_DEPTH must be a non-negative integer" \
  require_non_negative_integer "GIT_CLONE_DEPTH" "-1"

assert_fails_with \
  "GIT_CLONE_DEPTH must be a non-negative integer" \
  require_non_negative_integer "GIT_CLONE_DEPTH" "1.5"

echo "PASS: require_non_negative_integer() checks"

echo "Running JOB_ID validation checks"

assert_fails_with \
  "Invalid JOB_ID: ../../etc. Use only letters, digits, hyphens, and underscores." \
  validate_job_id "../../etc"

assert_fails_with \
  "Invalid JOB_ID: ../escape. Use only letters, digits, hyphens, and underscores." \
  validate_job_id "../escape"

assert_fails_with \
  "Invalid JOB_ID: bad/slash. Use only letters, digits, hyphens, and underscores." \
  validate_job_id "bad/slash"

assert_fails_with \
  "Invalid JOB_ID: /abs/path. Use only letters, digits, hyphens, and underscores." \
  validate_job_id "/abs/path"

assert_fails_with \
  "Invalid JOB_ID: job id. Use only letters, digits, hyphens, and underscores." \
  validate_job_id "job id"

assert_fails_with \
  'Invalid JOB_ID: job;id. Use only letters, digits, hyphens, and underscores.' \
  validate_job_id "job;id"

echo "PASS: JOB_ID validation checks"

echo "Running validate_url_scheme() unit checks"

assert_validate_url_passes() {
  local url="$1"
  if ! validate_url_scheme "$url" "TEST_URL"; then
    fail "validate_url_scheme should accept: ${url}"
  fi
}

assert_validate_url_rejects() {
  local url="$1"
  local expected_msg="$2"
  local stderr_file
  stderr_file="$(mktemp)"
  if validate_url_scheme "$url" "TEST_URL" 2>"$stderr_file"; then
    rm -f "$stderr_file"
    fail "validate_url_scheme should reject: ${url}"
  fi
  if ! grep -qF "$expected_msg" "$stderr_file"; then
    echo "Expected stderr to contain: ${expected_msg}" >&2
    echo "Actual stderr:" >&2
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    fail "stderr mismatch for URL: ${url}"
  fi
  rm -f "$stderr_file"
}

assert_validate_url_passes "https://api.example.com/tasks/claim"
assert_validate_url_passes "http://localhost:8080/tasks/claim"
assert_validate_url_rejects "ftp://evil.example.com/steal" "must begin with https:// or http://"
assert_validate_url_rejects "file:///etc/passwd" "must begin with https:// or http://"
assert_validate_url_rejects "javascript:alert(1)" "must begin with https:// or http://"
assert_validate_url_rejects "" "must begin with https:// or http://"

echo "PASS: validate_url_scheme() unit checks"
