#!/usr/bin/env bash
# shellcheck disable=SC2030,SC2031
# Integration test for controller/triggers/messaging.sh.
#
# Stubs the hivemoot-agent CLI on PATH and exercises the host-side
# watcher's NDJSON consumption path plus the busy-ack delivery path.
# The real CLI is covered by cli/tests/test_messaging_cli.py.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $message" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

assert_file_contains() {
  local path="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$path"; then
    echo "FAIL: expected '$needle' in $path" >&2
    echo "--- file contents ---" >&2
    sed 's/^/  /' "$path" >&2
    exit 1
  fi
}

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

# ── Stub hivemoot-agent CLI ─────────────────────────────────────────
#
# The stub dispatches on the first two positional args to simulate
# either `messaging watch` (emits a canned NDJSON stream from a
# fixture file) or `messaging send` (appends invocation args to a log).
mkdir -p "$tmp_dir/bin"
cat > "$tmp_dir/bin/hivemoot-agent" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "messaging" ] && [ "${2:-}" = "watch" ]; then
  if [ -n "${WATCH_FIXTURE:-}" ] && [ -f "$WATCH_FIXTURE" ]; then
    cat "$WATCH_FIXTURE"
  fi
  # Simulate a CLI exit so the shell watcher's backoff can engage.
  exit 1
fi

if [ "${1:-}" = "messaging" ] && [ "${2:-}" = "send" ]; then
  # Log chat-id + stdin payload so the busy-ack test can assert.
  local_chat_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --chat-id) local_chat_id="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  local_body="$(cat)"
  printf '%s|%s\n' "$local_chat_id" "$local_body" >> "${SEND_LOG:?SEND_LOG not set}"
  exit 0
fi

echo "stub: unhandled invocation: $*" >&2
exit 2
STUB
chmod +x "$tmp_dir/bin/hivemoot-agent"

# ── Case 1: watch consumer dispatches enqueues ─────────────────────

run_watch_consumer_dispatch_case() {
  local case_dir="${tmp_dir}/case-watch"
  mkdir -p "$case_dir"

  local fixture="${case_dir}/updates.ndjson"
  cat > "$fixture" <<'EOF'
{"update_id":100,"chat_id":"55555","username":"alice","text":"hi"}
{"update_id":101,"chat_id":"55555","username":"alice","text":"second"}
EOF

  # shellcheck disable=SC2030,SC2031,SC2034,SC2154,SC1091,SC2317,SC2329
  (
    set -euo pipefail

    export PATH="${tmp_dir}/bin:${PATH}"
    # controller/main.sh resolves HIVEMOOT_AGENT_CLI at startup; in
    # this test we source messaging.sh directly so we set it ourselves.
    export HIVEMOOT_AGENT_CLI="${tmp_dir}/bin/hivemoot-agent"
    export WATCH_FIXTURE="$fixture"

    export SHARED_DIR="${repo_root}/shared"

    workspace_root="${case_dir}/workspace"
    queue_root="${workspace_root}/queue"
    watch_state_root="${workspace_root}/watch-state"
    messaging_homes_root="${workspace_root}/messaging-homes"
    messaging_sessions_root="${workspace_root}/messaging-sessions"
    mkdir -p "$queue_root" "$watch_state_root" \
             "$messaging_homes_root" "$messaging_sessions_root"

    # shellcheck disable=SC2034  # consumed by sourced trigger files.
    controller_instance_id="test"
    # shellcheck disable=SC2034
    docker_cmd="/bin/true"
    # shellcheck disable=SC2034
    target_repo="owner/repo"
    # shellcheck disable=SC2034
    messaging_agent_id="worker"
    # shellcheck disable=SC2034
    messaging_target_repo="owner/repo"
    # shellcheck disable=SC2034
    MESSAGING_ALLOWED_CHAT_IDS="55555"
    # shellcheck disable=SC2034
    MESSAGING_PLATFORM="telegram"

    . "${repo_root}/shared/lib.sh"
    CORE_DIR="${repo_root}/controller/core"
    . "${CORE_DIR}/common.sh"
    TRIGGER_DIR="${repo_root}/controller/triggers"
    . "${TRIGGER_DIR}/common.sh"
    . "${TRIGGER_DIR}/messaging.sh"

    # Override write_trigger_file to record calls instead of writing.
    calls_log="${case_dir}/calls.log"
    # shellcheck disable=SC2317
    write_trigger_file() {
      printf '%s|%s|%s|%s\n' "$3" "$5" "$7" "$4" >> "$calls_log"
      return 0
    }
    # Override queue_has_ack_key to always say "not seen" for this test.
    # shellcheck disable=SC2317
    queue_has_ack_key() { return 1; }
    # Silence log()
    # shellcheck disable=SC2317
    log() { return 0; }

    _messaging_consume_watch || true

    [ -f "$calls_log" ] || { echo "FAIL: no enqueue calls recorded" >&2; exit 1; }

    local lines=""
    lines="$(wc -l < "$calls_log" | tr -d '[:space:]')"
    [ "$lines" = "2" ] \
      || { echo "FAIL: expected 2 enqueues, got ${lines}" >&2; cat "$calls_log" >&2; exit 1; }

    grep -qF "worker|tg-msg:100|tg:55555|hi" "$calls_log" \
      || { echo "FAIL: first enqueue line missing or wrong" >&2; cat "$calls_log" >&2; exit 1; }
    grep -qF "worker|tg-msg:101|tg:55555|second" "$calls_log" \
      || { echo "FAIL: second enqueue line missing or wrong" >&2; cat "$calls_log" >&2; exit 1; }
  ) || fail "watch consumer dispatch subshell failed"

  echo "PASS: watch consumer dispatches one enqueue per NDJSON line"
}

# ── Case 2: busy-ack invokes hivemoot-agent messaging send ──────────

run_busy_ack_via_cli_case() {
  local case_dir="${tmp_dir}/case-busy-ack"
  mkdir -p "$case_dir"

  local send_log="${case_dir}/send.log"
  : > "$send_log"

  # shellcheck disable=SC2030,SC2031,SC2034,SC2154,SC1091,SC2317,SC2329
  (
    set -euo pipefail

    export PATH="${tmp_dir}/bin:${PATH}"
    # controller/main.sh resolves HIVEMOOT_AGENT_CLI at startup; in
    # this test we source messaging.sh directly so we set it ourselves.
    export HIVEMOOT_AGENT_CLI="${tmp_dir}/bin/hivemoot-agent"
    export SEND_LOG="$send_log"
    export SHARED_DIR="${repo_root}/shared"

    workspace_root="${case_dir}/workspace"
    queue_root="${workspace_root}/queue"
    messaging_homes_root="${workspace_root}/messaging-homes"
    messaging_sessions_root="${workspace_root}/messaging-sessions"
    mkdir -p "$queue_root" "$messaging_homes_root" "$messaging_sessions_root"

    . "${repo_root}/shared/lib.sh"
    CORE_DIR="${repo_root}/controller/core"
    . "${CORE_DIR}/common.sh"
    TRIGGER_DIR="${repo_root}/controller/triggers"
    . "${TRIGGER_DIR}/common.sh"
    . "${TRIGGER_DIR}/messaging.sh"

    local proc_file="${queue_root}/msg-dup.processing"
    printf '%s' '{"trigger_type":"messaging","repo":"owner/repo","agent_id":"chat","extra_prompt":"hi","ack_key":"tg-msg:1","state_file":"","session_key":"tg:55555"}' > "$proc_file"

    controller_trigger_on_duplicate_agent__messaging "$proc_file"

    # After ack, the file should be requeued with messaging_acked: true.
    local requeued="${queue_root}/msg-dup.trigger.json"
    [ -f "$requeued" ] || { echo "FAIL: trigger not requeued" >&2; exit 1; }

    local acked=""
    acked="$(jq -r '.messaging_acked' "$requeued")"
    [ "$acked" = "true" ] || { echo "FAIL: messaging_acked not set (got ${acked})" >&2; exit 1; }

    # Second and third queue passes must not fire additional acks.
    mv "$requeued" "$proc_file"
    controller_trigger_on_duplicate_agent__messaging "$proc_file"
    requeued="${queue_root}/msg-dup.trigger.json"
    mv "$requeued" "$proc_file"
    controller_trigger_on_duplicate_agent__messaging "$proc_file"
  )

  assert_file_contains "$send_log" "55555|"
  local ack_count=""
  ack_count="$(wc -l < "$send_log" | tr -d '[:space:]')"
  assert_eq "1" "$ack_count" "expected exactly one busy-ack across three passes"

  echo "PASS: busy-ack invokes hivemoot-agent messaging send once across retries"
}

# ── Case 3: malformed lines don't crash the consumer ──────────────

run_malformed_line_tolerance_case() {
  local case_dir="${tmp_dir}/case-malformed"
  mkdir -p "$case_dir"

  local fixture="${case_dir}/updates.ndjson"
  # Missing text → should be skipped; valid line → should enqueue.
  cat > "$fixture" <<'EOF'
{"update_id":1,"chat_id":"55555","username":"alice"}
not-json-at-all
{"update_id":2,"chat_id":"55555","username":"alice","text":"valid"}
EOF

  # shellcheck disable=SC2030,SC2031,SC2034,SC2154,SC1091,SC2317,SC2329
  (
    set -euo pipefail

    export PATH="${tmp_dir}/bin:${PATH}"
    # controller/main.sh resolves HIVEMOOT_AGENT_CLI at startup; in
    # this test we source messaging.sh directly so we set it ourselves.
    export HIVEMOOT_AGENT_CLI="${tmp_dir}/bin/hivemoot-agent"
    export WATCH_FIXTURE="$fixture"
    export SHARED_DIR="${repo_root}/shared"

    workspace_root="${case_dir}/workspace"
    watch_state_root="${workspace_root}/watch-state"
    mkdir -p "$workspace_root" "$watch_state_root"

    # shellcheck disable=SC2034  # consumed by sourced trigger files.
    controller_instance_id="test"
    # shellcheck disable=SC2034
    docker_cmd="/bin/true"
    # shellcheck disable=SC2034
    target_repo="owner/repo"
    # shellcheck disable=SC2034
    messaging_agent_id="worker"
    # shellcheck disable=SC2034
    messaging_target_repo="owner/repo"
    # shellcheck disable=SC2034
    MESSAGING_ALLOWED_CHAT_IDS="55555"
    # shellcheck disable=SC2034
    MESSAGING_PLATFORM="telegram"

    . "${repo_root}/shared/lib.sh"
    CORE_DIR="${repo_root}/controller/core"
    . "${CORE_DIR}/common.sh"
    TRIGGER_DIR="${repo_root}/controller/triggers"
    . "${TRIGGER_DIR}/common.sh"
    . "${TRIGGER_DIR}/messaging.sh"

    calls_log="${case_dir}/calls.log"
    # shellcheck disable=SC2317
    write_trigger_file() {
      printf '%s\n' "$7" >> "$calls_log"
      return 0
    }
    # shellcheck disable=SC2317
    queue_has_ack_key() { return 1; }
    # shellcheck disable=SC2317
    log() { return 0; }

    _messaging_consume_watch || true

    local lines=0
    [ -f "$calls_log" ] && lines="$(wc -l < "$calls_log" | tr -d '[:space:]')"
    [ "$lines" = "1" ] \
      || { echo "FAIL: expected 1 enqueue after malformed filtering, got ${lines}" >&2; cat "$calls_log" 2>/dev/null >&2; exit 1; }
  ) || fail "malformed tolerance subshell failed"

  echo "PASS: malformed watch lines are skipped without crashing the loop"
}

run_watch_consumer_dispatch_case
run_busy_ack_via_cli_case
run_malformed_line_tolerance_case

echo "PASS: messaging trigger checks"
