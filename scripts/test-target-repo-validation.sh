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
workload_env="AGENT_IDENTITY=hivemoot-agent IDENTITY_DIR=${repo_root}/identities/hivemoot-agent AGENT_WORKLOAD=github-workload WORKLOAD_DIR=${repo_root}/scripts/test-fixtures/github-workload INTEGRATION_DIR=${repo_root}/integrations KERNEL_DIR=${repo_root}/scripts RUNNER_DIR=${repo_root}/runners"

echo "Running TARGET_REPO validation checks"

assert_fails_with \
  "TARGET_REPO is required. Set it as owner/repo." \
  env -u TARGET_REPO $workload_env bash scripts/run-once.sh

assert_fails_with \
  "Invalid TARGET_REPO: not-a-repo. Expected owner/repo." \
  env TARGET_REPO=not-a-repo $workload_env bash scripts/run-once.sh

assert_fails_with \
  "TARGET_REPO is required. Set it as owner/repo." \
  env -u TARGET_REPO $workload_env AGENT_DRIVER=once AGENT_ID_01=worker AGENT_GITHUB_TOKEN_01=dummy bash scripts/entrypoint.sh

assert_fails_with \
  "Invalid TARGET_REPO: not-a-repo. Expected owner/repo." \
  env TARGET_REPO=not-a-repo $workload_env AGENT_DRIVER=once AGENT_ID_01=worker AGENT_GITHUB_TOKEN_01=dummy bash scripts/entrypoint.sh

assert_fails_with \
  "TARGET_REPO is required. Set it as owner/repo." \
  env -u TARGET_REPO -u WATCH_MENTIONS $workload_env AGENT_ID=worker AGENT_TOKEN=dummy bash scripts/run-loop.sh

assert_fails_with \
  "Invalid TARGET_REPO: not-a-repo. Expected owner/repo." \
  env -u WATCH_MENTIONS TARGET_REPO=not-a-repo $workload_env AGENT_ID=worker AGENT_TOKEN=dummy bash scripts/run-loop.sh

# Regression: leading-dot owner components allow path traversal in filesystem
# path construction (e.g. ${cache}/../evil → parent dir). The owner segment
# must start with an alphanumeric character.
assert_fails_with \
  "Invalid TARGET_REPO: ../evil. Expected owner/repo." \
  env TARGET_REPO=../evil $workload_env bash scripts/run-once.sh

# Regression: bare . and .. as the repo segment are rejected; they would
# resolve to the current or parent directory in path construction.
assert_fails_with \
  "Invalid TARGET_REPO: owner/.. Expected owner/repo." \
  env TARGET_REPO=owner/. $workload_env bash scripts/run-once.sh

assert_fails_with \
  "Invalid TARGET_REPO: owner/... Expected owner/repo." \
  env TARGET_REPO=owner/.. $workload_env bash scripts/run-once.sh

echo "PASS: TARGET_REPO validation checks"
