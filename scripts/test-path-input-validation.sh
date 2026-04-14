#!/usr/bin/env bash
# shellcheck disable=SC2086  # $workload_env intentionally word-split for env
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

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workload_env="AGENT_IDENTITY=hivemoot-agent IDENTITY_DIR=${repo_root}/identities/hivemoot-agent AGENT_WORKLOAD=hivemoot WORKLOAD_DIR=${repo_root}/workloads/hivemoot INTEGRATION_DIR=${repo_root}/integrations KERNEL_DIR=${repo_root}/scripts RUNNER_DIR=${repo_root}/runners"

echo "Running workspace root and agent ID validation checks"

assert_fails_with \
  "WORKSPACE_ROOT must be an absolute path" \
  env TARGET_REPO=owner/repo $workload_env WORKSPACE_ROOT=relative bash scripts/run-once.sh

assert_fails_with \
  "WORKSPACE_ROOT must be an absolute path" \
  env TARGET_REPO=owner/repo $workload_env WORKSPACE_ROOT=relative AGENT_DRIVER=once AGENT_ID_01=worker AGENT_GITHUB_TOKEN_01=dummy bash scripts/entrypoint.sh

assert_fails_with \
  "WORKSPACE_ROOT must be an absolute path" \
  env TARGET_REPO=owner/repo $workload_env WORKSPACE_ROOT=relative AGENT_ID_01=worker AGENT_GITHUB_TOKEN_01=dummy bash scripts/run-loop.sh

assert_fails_with \
  "Invalid AGENT_ID: ." \
  env TARGET_REPO=owner/repo $workload_env AGENT_ID_01=. AGENT_GITHUB_TOKEN_01=dummy bash scripts/run-loop.sh

assert_fails_with \
  "Invalid AGENT_ID: .." \
  env TARGET_REPO=owner/repo $workload_env AGENT_ID_01=.. AGENT_GITHUB_TOKEN_01=dummy bash scripts/run-loop.sh

echo "PASS: workspace root and agent ID validation checks"

echo "Running GIT_CLONE_DEPTH validation checks"

assert_fails_with \
  "Unsupported GIT_CLONE_DEPTH: abc. Use 0 (full clone) or a positive integer." \
  env TARGET_REPO=owner/repo $workload_env GIT_CLONE_DEPTH=abc bash scripts/run-once.sh

assert_fails_with \
  "Unsupported GIT_CLONE_DEPTH: -1. Use 0 (full clone) or a positive integer." \
  env TARGET_REPO=owner/repo $workload_env GIT_CLONE_DEPTH=-1 bash scripts/run-once.sh

assert_fails_with \
  "Unsupported GIT_CLONE_DEPTH: 1.5. Use 0 (full clone) or a positive integer." \
  env TARGET_REPO=owner/repo $workload_env GIT_CLONE_DEPTH=1.5 bash scripts/run-once.sh

echo "PASS: GIT_CLONE_DEPTH validation checks"

echo "Running JOB_ID validation checks"

assert_fails_with \
  "Invalid JOB_ID: ../../etc. Use only letters, digits, hyphens, and underscores." \
  env TARGET_REPO=owner/repo $workload_env JOB_ID=../../etc bash scripts/run-once.sh

assert_fails_with \
  "Invalid JOB_ID: ../escape. Use only letters, digits, hyphens, and underscores." \
  env TARGET_REPO=owner/repo $workload_env JOB_ID=../escape bash scripts/run-once.sh

assert_fails_with \
  "Invalid JOB_ID: bad/slash. Use only letters, digits, hyphens, and underscores." \
  env TARGET_REPO=owner/repo $workload_env JOB_ID=bad/slash bash scripts/run-once.sh

assert_fails_with \
  "Invalid JOB_ID: /abs/path. Use only letters, digits, hyphens, and underscores." \
  env TARGET_REPO=owner/repo $workload_env 'JOB_ID=/abs/path' bash scripts/run-once.sh

assert_fails_with \
  "Invalid JOB_ID: job id. Use only letters, digits, hyphens, and underscores." \
  env TARGET_REPO=owner/repo $workload_env 'JOB_ID=job id' bash scripts/run-once.sh

assert_fails_with \
  'Invalid JOB_ID: job;id. Use only letters, digits, hyphens, and underscores.' \
  env TARGET_REPO=owner/repo $workload_env 'JOB_ID=job;id' bash scripts/run-once.sh

echo "PASS: JOB_ID validation checks"

echo "Running validate_url_scheme() unit checks"

# Source lib.sh directly to test the helper in isolation.
repo_root_abs="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1090
. "${repo_root_abs}/shared/lib.sh"

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
