#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains_line() {
  local file="$1"
  local expected="$2"
  if ! grep -Fqx "$expected" "$file"; then
    echo "Expected line:" >&2
    echo "  $expected" >&2
    echo "Actual file (${file}):" >&2
    sed 's/^/  /' "$file" >&2 || true
    fail "missing expected line"
  fi
}

setup_mock_bin() {
  local mock_bin="$1"
  mkdir -p "$mock_bin"

  cat > "${mock_bin}/gh" <<'EOF_GH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "api" ]; then
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi

case "${2:-}" in
  user)
    echo '{"login":"mock-user"}'
    ;;
  installation)
    echo '{"id":1}'
    ;;
  repos/*)
    repo="${2#repos/}"
    printf '{"full_name":"%s"}\n' "$repo"
    ;;
  *)
    echo "unexpected gh api endpoint: ${2:-}" >&2
    exit 1
    ;;
esac
EOF_GH

  cat > "${mock_bin}/hivemoot" <<'EOF_HIVEMOOT'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  --version)
    echo "hivemoot 0.0.0-test"
    ;;
  watch)
    if [ -n "${MOCK_HIVEMOOT_WATCH_OUTPUT:-}" ]; then
      printf '%s\n' "$MOCK_HIVEMOOT_WATCH_OUTPUT"
    fi
    ;;
  ack)
    if [ -n "${MOCK_HIVEMOOT_ACK_LOG:-}" ]; then
      printf '%s\n' "$*" >> "$MOCK_HIVEMOOT_ACK_LOG"
    fi
    ;;
  *)
    echo "unexpected hivemoot invocation: $*" >&2
    exit 1
    ;;
esac
EOF_HIVEMOOT

  cat > "${mock_bin}/claude" <<'EOF_CLAUDE'
#!/usr/bin/env bash
exit 0
EOF_CLAUDE

  chmod +x "${mock_bin}/gh" "${mock_bin}/hivemoot" "${mock_bin}/claude"
}

run_periodic_fallback_propagation_case() {
  local repo_root="$1"
  local case_dir="$2"
  local result_file="${case_dir}/results.log"
  local run_log="${case_dir}/run-loop.log"
  local run_once_script="${case_dir}/run-once-mock.sh"

  mkdir -p "${case_dir}/workspace"
  printf 'prompt\n' > "${case_dir}/prompt.md"
  : > "$result_file"

  setup_mock_bin "${case_dir}/mock-bin"

  cat > "$run_once_script" <<'EOF_RUN_ONCE'
#!/usr/bin/env bash
set -euo pipefail

if [ -n "${AGENT_SESSION_KEY:-}" ]; then
  printf 'unexpected:mention:%s\n' "${PERIODIC_INTERVAL_SECS:-unset}" >> "$MOCK_RESULT_FILE"
  exit 1
fi

if [ "${PERIODIC_INTERVAL_SECS:-}" = "1" ]; then
  printf 'periodic:propagated:1\n' >> "$MOCK_RESULT_FILE"
else
  printf 'periodic:missing:%s\n' "${PERIODIC_INTERVAL_SECS:-unset}" >> "$MOCK_RESULT_FILE"
fi

exit 1
EOF_RUN_ONCE
  chmod +x "$run_once_script"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="claude" \
    AGENT_PROMPT_FILE="${case_dir}/prompt.md" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    HIVEMOOT_CLI_UPDATE="skip" \
    BASE_SECS="1" \
    PERIODIC_JITTER_SECS="0" \
    MAX_CONSECUTIVE_FAILURES="1" \
    RUN_ONCE_SCRIPT="$run_once_script" \
    MOCK_RESULT_FILE="$result_file" \
    bash "${repo_root}/scripts/run-loop.sh" >"$run_log" 2>&1
  then
    sed 's/^/  /' "$run_log" >&2 || true
    fail "run-loop succeeded unexpectedly in periodic fallback case"
  fi

  assert_file_contains_line "$result_file" "periodic:propagated:1"
  if grep -Fq 'periodic:missing:' "$result_file"; then
    sed 's/^/  /' "$result_file" >&2
    fail "periodic fallback did not propagate resolved interval"
  fi
}

run_mention_omits_interval_case() {
  local repo_root="$1"
  local case_dir="$2"
  local result_file="${case_dir}/results.log"
  local run_log="${case_dir}/run-loop.log"
  local run_once_script="${case_dir}/run-once-mock.sh"
  local ack_log="${case_dir}/ack.log"

  mkdir -p "${case_dir}/workspace"
  printf 'prompt\n' > "${case_dir}/prompt.md"
  : > "$result_file"
  : > "$ack_log"

  setup_mock_bin "${case_dir}/mock-bin"

  cat > "$run_once_script" <<'EOF_RUN_ONCE'
#!/usr/bin/env bash
set -euo pipefail

if [ -n "${AGENT_SESSION_KEY:-}" ]; then
  if [ -n "${PERIODIC_INTERVAL_SECS:-}" ]; then
    printf 'mention:has_interval:%s\n' "$PERIODIC_INTERVAL_SECS" >> "$MOCK_RESULT_FILE"
  else
    printf 'mention:interval_omitted\n' >> "$MOCK_RESULT_FILE"
  fi
  exit 0
fi

printf 'periodic:run\n' >> "$MOCK_RESULT_FILE"
exit 1
EOF_RUN_ONCE
  chmod +x "$run_once_script"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="claude" \
    AGENT_PROMPT_FILE="${case_dir}/prompt.md" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    HIVEMOOT_CLI_UPDATE="skip" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="1" \
    PERIODIC_INTERVAL_SECS="2" \
    PERIODIC_JITTER_SECS="0" \
    MAX_CONSECUTIVE_FAILURES="1" \
    RUN_ONCE_SCRIPT="$run_once_script" \
    MOCK_RESULT_FILE="$result_file" \
    MOCK_HIVEMOOT_ACK_LOG="$ack_log" \
    MOCK_HIVEMOOT_WATCH_OUTPUT='{"threadId":"thread-1","number":42,"title":"Mention","author":"hivemoot","body":"@hivemoot-worker ping","url":"https://github.com/owner/repo/issues/1#issuecomment-1","timestamp":"2026-02-26T23:00:00Z"}' \
    bash "${repo_root}/scripts/run-loop.sh" >"$run_log" 2>&1
  then
    sed 's/^/  /' "$run_log" >&2 || true
    fail "run-loop succeeded unexpectedly in mention omission case"
  fi

  assert_file_contains_line "$result_file" "mention:interval_omitted"
  if grep -Fq 'mention:has_interval:' "$result_file"; then
    sed 's/^/  /' "$result_file" >&2
    fail "mention-triggered run inherited periodic interval"
  fi
}

run_periodic_trigger_type_case() {
  local repo_root="$1"
  local case_dir="$2"
  local result_file="${case_dir}/results.log"
  local run_log="${case_dir}/run-loop.log"
  local run_once_script="${case_dir}/run-once-mock.sh"

  mkdir -p "${case_dir}/workspace"
  printf 'prompt\n' > "${case_dir}/prompt.md"
  : > "$result_file"

  setup_mock_bin "${case_dir}/mock-bin"

  cat > "$run_once_script" <<'EOF_RUN_ONCE'
#!/usr/bin/env bash
set -euo pipefail

printf 'trigger_type:%s\n' "${RUN_TRIGGER_TYPE:-unset}" >> "$MOCK_RESULT_FILE"
exit 1
EOF_RUN_ONCE
  chmod +x "$run_once_script"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="claude" \
    AGENT_PROMPT_FILE="${case_dir}/prompt.md" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    HIVEMOOT_CLI_UPDATE="skip" \
    BASE_SECS="1" \
    PERIODIC_JITTER_SECS="0" \
    MAX_CONSECUTIVE_FAILURES="1" \
    RUN_ONCE_SCRIPT="$run_once_script" \
    MOCK_RESULT_FILE="$result_file" \
    bash "${repo_root}/scripts/run-loop.sh" >"$run_log" 2>&1
  then
    sed 's/^/  /' "$run_log" >&2 || true
    fail "run-loop succeeded unexpectedly in periodic trigger type case"
  fi

  assert_file_contains_line "$result_file" "trigger_type:scheduled"
  if grep -Fq 'trigger_type:manual' "$result_file" || grep -Fq 'trigger_type:unset' "$result_file"; then
    sed 's/^/  /' "$result_file" >&2
    fail "periodic run did not export RUN_TRIGGER_TYPE=scheduled"
  fi

  echo "PASS: periodic run exports RUN_TRIGGER_TYPE=scheduled"
}

run_mention_trigger_type_case() {
  local repo_root="$1"
  local case_dir="$2"
  local result_file="${case_dir}/results.log"
  local run_log="${case_dir}/run-loop.log"
  local run_once_script="${case_dir}/run-once-mock.sh"
  local ack_log="${case_dir}/ack.log"

  mkdir -p "${case_dir}/workspace"
  printf 'prompt\n' > "${case_dir}/prompt.md"
  : > "$result_file"
  : > "$ack_log"

  setup_mock_bin "${case_dir}/mock-bin"

  cat > "$run_once_script" <<'EOF_RUN_ONCE'
#!/usr/bin/env bash
set -euo pipefail

if [ -n "${AGENT_SESSION_KEY:-}" ]; then
  printf 'mention_trigger_type:%s\n' "${RUN_TRIGGER_TYPE:-unset}" >> "$MOCK_RESULT_FILE"
  exit 0
fi

printf 'periodic_trigger_type:%s\n' "${RUN_TRIGGER_TYPE:-unset}" >> "$MOCK_RESULT_FILE"
exit 1
EOF_RUN_ONCE
  chmod +x "$run_once_script"

  if env -i \
    PATH="${case_dir}/mock-bin:${PATH}" \
    HOME="${case_dir}/home" \
    WORKSPACE_ROOT="${case_dir}/workspace" \
    TARGET_REPO="owner/repo" \
    AGENT_PROVIDER="claude" \
    AGENT_PROMPT_FILE="${case_dir}/prompt.md" \
    AGENT_ID_01="worker" \
    AGENT_GITHUB_TOKEN_01="token-1" \
    HIVEMOOT_CLI_UPDATE="skip" \
    WATCH_MENTIONS="1" \
    WATCH_POLL_INTERVAL="1" \
    PERIODIC_INTERVAL_SECS="2" \
    PERIODIC_JITTER_SECS="0" \
    MAX_CONSECUTIVE_FAILURES="1" \
    RUN_ONCE_SCRIPT="$run_once_script" \
    MOCK_RESULT_FILE="$result_file" \
    MOCK_HIVEMOOT_ACK_LOG="$ack_log" \
    MOCK_HIVEMOOT_WATCH_OUTPUT='{"threadId":"thread-1","number":42,"title":"Mention","author":"hivemoot","body":"@hivemoot-worker ping","url":"https://github.com/owner/repo/issues/1#issuecomment-1","timestamp":"2026-02-26T23:00:00Z"}' \
    bash "${repo_root}/scripts/run-loop.sh" >"$run_log" 2>&1
  then
    sed 's/^/  /' "$run_log" >&2 || true
    fail "run-loop succeeded unexpectedly in mention trigger type case"
  fi

  assert_file_contains_line "$result_file" "mention_trigger_type:mention"
  if grep -Fq 'mention_trigger_type:scheduled' "$result_file" || grep -Fq 'mention_trigger_type:manual' "$result_file"; then
    sed 's/^/  /' "$result_file" >&2
    fail "mention-triggered run did not export RUN_TRIGGER_TYPE=mention"
  fi

  echo "PASS: mention-triggered run exports RUN_TRIGGER_TYPE=mention"
}

echo "Running run-loop next_run_at propagation checks"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
tmp_root="$(mktemp -d "${repo_root}/.tmp-run-loop-next-run.XXXXXX")"
trap 'rm -rf "$tmp_root"' EXIT

run_periodic_fallback_propagation_case "$repo_root" "${tmp_root}/periodic-fallback"
run_mention_omits_interval_case "$repo_root" "${tmp_root}/mention-omission"
run_periodic_trigger_type_case "$repo_root" "${tmp_root}/periodic-trigger-type"
run_mention_trigger_type_case "$repo_root" "${tmp_root}/mention-trigger-type"

echo "PASS: run-loop next_run_at propagation checks"
