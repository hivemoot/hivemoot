#!/usr/bin/env bash
# Compose-side surface check for the plugin engine.
#
# Worker entrypoint behavior (provider mismatch, AGENT_PLUGINS
# validation, GitHub token bridging, Claude OAuth bootstrap) lives
# in cli/hivemoot_agent/worker.py and is unit-tested in
# cli/tests/test_worker_cli.py.  This file only verifies the
# compose-level wiring that those Python tests can't reach.
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains_text() {
  local path="$1"
  local expected="$2"
  if ! grep -Fq "$expected" "$path"; then
    echo "Expected file to contain text:" >&2
    echo "  $expected" >&2
    echo "Actual file:" >&2
    sed 's/^/  /' "$path" >&2
    fail "missing expected text in ${path}"
  fi
}

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

echo "Running plugin engine compose-config check"

# Compose config exposes AGENT_PLUGINS with the documented default
# (empty unless the operator overrides) and surfaces operator-set
# vars passed through the env file.
compose_file="$tmp_dir/compose.out"
env \
  AGENT_PLUGINS= \
  HIVEMOOT_BUZZ_ROLE=reviewer \
  docker compose config > "$compose_file"

assert_file_contains_text "$compose_file" 'AGENT_PLUGINS: ""'
assert_file_contains_text "$compose_file" "HIVEMOOT_BUZZ_ROLE: reviewer"

echo "PASS: plugin engine compose-config check"
