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
cleanup() { rm -rf "$tmp_home"; }
trap cleanup EXIT

echo "Running provider mismatch detection checks"

# Mismatch: image built for codex but agent requests claude
assert_fails_with \
  "Provider mismatch: image built for 'codex' but AGENT_PROVIDER='claude'." \
  env HOME="$tmp_home" \
      DOCKER_PROVIDER=codex \
      AGENT_PROVIDER=claude \
      AGENT_PLUGINS=github,hivemoot-github \
      bash scripts/entrypoint.sh

# Mismatch message offers .env fix first (cheaper than rebuild)
assert_fails_with \
  "Use baked provider: set AGENT_PROVIDER=codex in .env" \
  env HOME="$tmp_home" \
      DOCKER_PROVIDER=codex \
      AGENT_PROVIDER=claude \
      AGENT_PLUGINS=github,hivemoot-github \
      bash scripts/entrypoint.sh

# Mismatch message also offers the rebuild path
assert_fails_with \
  "Switch providers:   PROVIDER=claude docker compose build hivemoot-agent" \
  env HOME="$tmp_home" \
      DOCKER_PROVIDER=codex \
      AGENT_PROVIDER=claude \
      AGENT_PLUGINS=github,hivemoot-github \
      bash scripts/entrypoint.sh

# Mismatch: image built for claude but agent requests gemini
assert_fails_with \
  "Provider mismatch: image built for 'claude' but AGENT_PROVIDER='gemini'." \
  env HOME="$tmp_home" \
      DOCKER_PROVIDER=claude \
      AGENT_PROVIDER=gemini \
      AGENT_PLUGINS=github,hivemoot-github \
      bash scripts/entrypoint.sh

# No mismatch: DOCKER_PROVIDER=all passes through regardless of AGENT_PROVIDER
# (all-provider image supports any provider — use nonexistent workload to stop early)
assert_fails_with \
  "Workload plugin not found" \
  env HOME="$tmp_home" \
      DOCKER_PROVIDER=all \
      AGENT_PROVIDER=claude \
      AGENT_WORKLOAD=nonexistent \
      bash scripts/entrypoint.sh

# No mismatch: DOCKER_PROVIDER matches AGENT_PROVIDER
assert_fails_with \
  "Workload plugin not found" \
  env HOME="$tmp_home" \
      DOCKER_PROVIDER=claude \
      AGENT_PROVIDER=claude \
      AGENT_WORKLOAD=nonexistent \
      bash scripts/entrypoint.sh

# No mismatch: DOCKER_PROVIDER unset (defaults to all, passes through)
assert_fails_with \
  "Workload plugin not found" \
  env HOME="$tmp_home" \
      AGENT_PROVIDER=claude \
      AGENT_WORKLOAD=nonexistent \
      bash scripts/entrypoint.sh

echo "PASS: provider mismatch detection checks"
