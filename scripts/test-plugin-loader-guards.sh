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

  if ! grep -Fq "$expected" "$stderr_file"; then
    echo "Expected stderr to contain:" >&2
    echo "  $expected" >&2
    echo "Actual stderr:" >&2
    sed 's/^/  /' "$stderr_file" >&2
    rm -f "$stderr_file"
    fail "stderr mismatch for: $*"
  fi

  rm -f "$stderr_file"
}

tmp_home="$(mktemp -d)"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
compat_dir="${repo_root}/compat"
cleanup() { rm -rf "$tmp_home"; }
trap cleanup EXIT

echo "Running plugin loader and dispatch guard checks"

assert_fails_with \
  "AGENT_TRIGGER is controller-only and is not used by the worker runtime." \
  env HOME="$tmp_home" \
      AGENT_WORKLOAD=hivemoot \
      AGENT_TRIGGER=periodic \
      WORKLOAD_DIR="${repo_root}/workloads/hivemoot" \
      INTEGRATION_DIR="${repo_root}/integrations" \
      DRIVER_DIR="${compat_dir}" \
      bash scripts/entrypoint.sh

assert_fails_with \
  "Driver not found" \
  env HOME="$tmp_home" \
      AGENT_WORKLOAD=hivemoot \
      AGENT_DRIVER=does-not-exist \
      WORKLOAD_DIR="${repo_root}/workloads/hivemoot" \
      INTEGRATION_DIR="${repo_root}/integrations" \
      DRIVER_DIR="${compat_dir}" \
      bash scripts/entrypoint.sh

assert_fails_with \
  "Driver 'task' has been removed. Task lifecycle is controller-owned; use AGENT_DRIVER=once for workers." \
  env HOME="$tmp_home" \
      AGENT_WORKLOAD=hivemoot-task \
      AGENT_DRIVER=task \
      WORKLOAD_DIR="${repo_root}/workloads/hivemoot-task" \
      INTEGRATION_DIR="${repo_root}/integrations" \
      DRIVER_DIR="${compat_dir}" \
      bash scripts/entrypoint.sh

assert_fails_with \
  "Driver 'task' has been removed. Task lifecycle is controller-owned; use AGENT_DRIVER=once for workers." \
  env HOME="$tmp_home" \
      bash "${compat_dir}/task.sh"

assert_fails_with \
  "Driver 'task' has been removed. Task lifecycle is controller-owned; use AGENT_DRIVER=once for workers." \
  env HOME="$tmp_home" \
      bash "${compat_dir}/task.sh"

assert_fails_with \
  "AGENT_IDENTITY is required. Set it to the identity name (e.g. hivemoot-agent)." \
  env HOME="$tmp_home" \
      AGENT_WORKLOAD=hivemoot \
      WORKLOAD_DIR="${repo_root}/workloads/hivemoot" \
      INTEGRATION_DIR="${repo_root}/integrations" \
      RUN_ONCE_SCRIPT=/usr/bin/true \
      bash "${compat_dir}/once.sh"

mkdir -p "${tmp_home}/integrations/github"
cp "${repo_root}/integrations/github/setup.sh" "${tmp_home}/integrations/github/setup.sh"

assert_fails_with \
  "Integration preflight plugin not found" \
  env HOME="$tmp_home" \
      AGENT_IDENTITY=hivemoot-agent \
      AGENT_WORKLOAD=hivemoot \
      IDENTITY_DIR="${repo_root}/identities/hivemoot-agent" \
      WORKLOAD_DIR="${repo_root}/workloads/hivemoot" \
      INTEGRATION_DIR="${tmp_home}/integrations" \
      RUN_ONCE_SCRIPT=/usr/bin/true \
      bash "${compat_dir}/once.sh"

assert_fails_with \
  "Identity plugin not found" \
  env HOME="$tmp_home" \
      AGENT_IDENTITY=does-not-exist \
      AGENT_WORKLOAD=hivemoot \
      WORKLOAD_DIR="${repo_root}/workloads/hivemoot" \
      INTEGRATION_DIR="${repo_root}/integrations" \
      RUN_ONCE_SCRIPT=/usr/bin/true \
      bash "${compat_dir}/once.sh"

echo "PASS: plugin loader and dispatch guard checks"
