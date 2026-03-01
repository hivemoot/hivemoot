#!/usr/bin/env bash
set -euo pipefail

# Test suite for health-reporter.sh and update_agent_stats() from lib.sh.
# Runs in CI without network access — all HTTP interactions are mocked.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TEST_TMP=""
TESTS_RUN=0
TESTS_PASSED=0

setup() {
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "$TEST_TMP"
}

fail() {
  echo "FAIL: $*" >&2
  teardown
  exit 1
}

pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
  echo "  PASS: $1"
}

run_test() {
  TESTS_RUN=$((TESTS_RUN + 1))
  "$@"
}

# ── helpers ──────────────────────────────────────────────────────

# Source lib.sh for update_agent_stats
source_lib() {
  # Reset the guard so we can re-source
  unset HIVEMOOT_LIB_LOADED 2>/dev/null || true
  # shellcheck source=scripts/lib.sh
  . "${SCRIPT_DIR}/lib.sh"
}

# Source health-reporter.sh with lib.sh already loaded
source_reporter() {
  unset HIVEMOOT_HEALTH_REPORTER_LOADED 2>/dev/null || true
  unset HIVEMOOT_LIB_LOADED 2>/dev/null || true
  # shellcheck source=scripts/lib.sh
  . "${SCRIPT_DIR}/lib.sh"
  # shellcheck source=scripts/health-reporter.sh
  . "${SCRIPT_DIR}/health-reporter.sh"
}

# Create a mock curl script that returns a specific HTTP status code.
make_mock_curl() {
  local http_code="$1"
  local curl_exit="${2:-0}"
  local mock_path="${TEST_TMP}/mock-curl"
  cat > "$mock_path" <<MOCK
#!/usr/bin/env bash
# Mock curl: returns HTTP $http_code
if [ "$curl_exit" -ne 0 ]; then
  exit $curl_exit
fi
echo "$http_code"
MOCK
  chmod +x "$mock_path"
  printf '%s' "$mock_path"
}

# Build a valid payload for testing (matches backend HealthReport schema)
build_test_payload() {
  source_reporter
  _build_health_payload \
    "test-agent" "hivemoot/sandbox" "20260226-120000-codex-test-agent" \
    "success" "1234" "0"
}

# ── update_agent_stats tests ─────────────────────────────────────

test_stats_creates_new_file() {
  source_lib
  local stats_file="${TEST_TMP}/stats-new.json"
  local result
  result="$(update_agent_stats "$stats_file" 0)"
  [ -f "$stats_file" ] || fail "stats file not created"
  local run_count error_count
  IFS=$'\t' read -r run_count error_count <<< "$result"
  [ "$run_count" -eq 1 ] || fail "expected run_count=1, got ${run_count}"
  [ "$error_count" -eq 0 ] || fail "expected error_count=0, got ${error_count}"
  pass "stats creates new file"
}

test_stats_increments_run_count() {
  source_lib
  local stats_file="${TEST_TMP}/stats-inc.json"
  printf '{"run_count":5,"error_count":2,"updated_at":"2026-01-01T00:00:00Z"}\n' > "$stats_file"
  local result
  result="$(update_agent_stats "$stats_file" 0)"
  local run_count error_count
  IFS=$'\t' read -r run_count error_count <<< "$result"
  [ "$run_count" -eq 6 ] || fail "expected run_count=6, got ${run_count}"
  [ "$error_count" -eq 2 ] || fail "expected error_count=2, got ${error_count}"
  pass "stats increments run_count"
}

test_stats_increments_error_count() {
  source_lib
  local stats_file="${TEST_TMP}/stats-err.json"
  printf '{"run_count":10,"error_count":3,"updated_at":"2026-01-01T00:00:00Z"}\n' > "$stats_file"
  local result
  result="$(update_agent_stats "$stats_file" 1)"
  local run_count error_count
  IFS=$'\t' read -r run_count error_count <<< "$result"
  [ "$run_count" -eq 11 ] || fail "expected run_count=11, got ${run_count}"
  [ "$error_count" -eq 4 ] || fail "expected error_count=4, got ${error_count}"
  pass "stats increments error_count"
}

test_stats_has_updated_at() {
  source_lib
  local stats_file="${TEST_TMP}/stats-ts.json"
  update_agent_stats "$stats_file" 0 > /dev/null
  local updated_at
  updated_at="$(jq -r '.updated_at' "$stats_file")"
  [ -n "$updated_at" ] || fail "expected updated_at to be set"
  [ "$updated_at" != "null" ] || fail "expected updated_at to not be null"
  pass "stats has updated_at timestamp"
}

# ── payload builder tests ────────────────────────────────────────

test_payload_has_required_fields() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  local actual_fields
  actual_fields="$(printf '%s' "$payload" | jq -r 'keys | .[]' | sort | tr '\n' ' ' | sed 's/ $//')"
  local expected="agent_id consecutive_failures duration_secs outcome repo run_id"
  [ "$actual_fields" = "$expected" ] || fail "field mismatch: expected [${expected}], got [${actual_fields}]"
  pass "payload has exactly required fields"
}

test_payload_field_count() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  local field_count
  field_count="$(printf '%s' "$payload" | jq 'keys | length')"
  [ "$field_count" -eq 6 ] || fail "expected exactly 6 fields, got ${field_count}"
  pass "payload has correct field count"
}

test_payload_optional_exit_code() {
  source_reporter
  local payload
  payload="$(_build_health_payload "a" "owner/repo" "run-1" "failure" "10" "1" "1")"
  local has_exit
  has_exit="$(printf '%s' "$payload" | jq 'has("exit_code")')"
  [ "$has_exit" = "true" ] || fail "expected exit_code field when provided"
  local exit_val
  exit_val="$(printf '%s' "$payload" | jq '.exit_code')"
  [ "$exit_val" = "1" ] || fail "expected exit_code=1, got ${exit_val}"
  pass "payload includes optional exit_code"
}

test_payload_optional_error() {
  source_reporter
  local payload
  payload="$(_build_health_payload "a" "owner/repo" "run-1" "failure" "10" "1" "1" "timeout exceeded")"
  local has_error
  has_error="$(printf '%s' "$payload" | jq 'has("error")')"
  [ "$has_error" = "true" ] || fail "expected error field when provided"
  local error_val
  error_val="$(printf '%s' "$payload" | jq -r '.error')"
  [ "$error_val" = "timeout exceeded" ] || fail "expected error='timeout exceeded', got '${error_val}'"
  pass "payload includes optional error"
}

test_payload_omits_empty_optionals() {
  source_reporter
  local payload
  payload="$(_build_health_payload "a" "owner/repo" "run-1" "success" "10" "0" "" "")"
  local field_count
  field_count="$(printf '%s' "$payload" | jq 'keys | length')"
  [ "$field_count" -eq 6 ] || fail "expected 6 fields without optionals, got ${field_count}"
  pass "payload omits empty optional fields"
}

test_payload_optional_next_run_at() {
  source_reporter
  local payload
  payload="$(_build_health_payload "a" "owner/repo" "run-1" "success" "10" "0" "" "" "2026-02-27T10:00:00Z")"
  local has_next
  has_next="$(printf '%s' "$payload" | jq 'has("next_run_at")')"
  [ "$has_next" = "true" ] || fail "expected next_run_at field when provided"
  local next_val
  next_val="$(printf '%s' "$payload" | jq -r '.next_run_at')"
  [ "$next_val" = "2026-02-27T10:00:00Z" ] || fail "expected next_run_at='2026-02-27T10:00:00Z', got '${next_val}'"
  pass "payload includes optional next_run_at"
}

test_payload_omits_empty_next_run_at() {
  source_reporter
  local payload
  payload="$(_build_health_payload "a" "owner/repo" "run-1" "success" "10" "0" "" "" "")"
  local has_next
  has_next="$(printf '%s' "$payload" | jq 'has("next_run_at")')"
  [ "$has_next" = "false" ] || fail "expected next_run_at to be omitted when empty"
  pass "payload omits empty next_run_at"
}

# ── validation tests ─────────────────────────────────────────────

test_validates_missing_agent_id() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.agent_id = ""')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject empty agent_id"
  fi
  pass "rejects missing agent_id"
}

test_validates_missing_repo() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.repo = ""')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject empty repo"
  fi
  pass "rejects missing repo"
}

test_validates_missing_run_id() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.run_id = ""')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject empty run_id"
  fi
  pass "rejects missing run_id"
}

test_validates_extra_fields() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '. + {"extra_field": "bad"}')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject extra fields"
  fi
  pass "rejects payload with extra fields"
}

test_valid_payload_passes() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  if ! _validate_health_payload "$payload" 2>/dev/null; then
    fail "valid payload should pass validation"
  fi
  pass "valid payload passes validation"
}

test_valid_payload_with_optionals_passes() {
  source_reporter
  local payload
  payload="$(_build_health_payload "a" "owner/repo" "run-1" "failure" "10" "1" "1" "some error")"
  if ! _validate_health_payload "$payload" 2>/dev/null; then
    fail "valid payload with optionals should pass validation"
  fi
  pass "valid payload with optionals passes validation"
}

test_valid_payload_with_next_run_at_passes() {
  source_reporter
  local payload
  payload="$(_build_health_payload "a" "owner/repo" "run-1" "success" "10" "0" "" "" "2026-02-27T10:00:00Z")"
  if ! _validate_health_payload "$payload" 2>/dev/null; then
    fail "valid payload with next_run_at should pass validation"
  fi
  pass "valid payload with next_run_at passes validation"
}

# ── validation — enums ───────────────────────────────────────────

test_validates_invalid_outcome_enum() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.outcome = "crashed"')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject invalid outcome"
  fi
  pass "rejects invalid outcome enum"
}

test_validates_valid_outcome_values() {
  source_reporter
  local payload_base
  payload_base="$(build_test_payload)"
  local outcome
  for outcome in success failure timeout; do
    local payload
    payload="$(printf '%s' "$payload_base" | jq --arg o "$outcome" '.outcome = $o')"
    if ! _validate_health_payload "$payload" 2>/dev/null; then
      fail "validation should accept outcome=${outcome}"
    fi
  done
  pass "accepts all valid outcome values"
}

test_validates_skipped_not_valid_outcome() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.outcome = "skipped"')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject 'skipped' — not in backend contract"
  fi
  pass "rejects 'skipped' as outcome (not in contract)"
}

# ── validation — numerics ────────────────────────────────────────

test_validates_negative_consecutive_failures() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.consecutive_failures = -1')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject negative consecutive_failures"
  fi
  pass "rejects negative consecutive_failures"
}

test_validates_negative_duration_secs() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.duration_secs = -100')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject negative duration_secs"
  fi
  pass "rejects negative duration_secs"
}

# ── validation — size budget ─────────────────────────────────────

test_validates_size_budget() {
  source_reporter
  # Build an oversized payload by stuffing agent_id
  local big_id
  big_id="$(printf 'x%.0s' $(seq 1 12000))"
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq --arg id "$big_id" '.agent_id = $id')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject oversized payload"
  fi
  pass "rejects payload exceeding size budget"
}

# ── response handling tests ──────────────────────────────────────

test_response_200() {
  source_reporter
  local mock_curl
  mock_curl="$(make_mock_curl 200)"
  local payload
  payload="$(build_test_payload)"

  # Override curl with mock
  local original_path="$PATH"
  PATH="$(dirname "$mock_curl"):$PATH"
  # Rename mock to curl
  cp "$mock_curl" "$(dirname "$mock_curl")/curl"
  chmod +x "$(dirname "$mock_curl")/curl"

  if ! _send_health_report "http://localhost/api/agent-health" "$payload" "" 2>/dev/null; then
    PATH="$original_path"
    fail "200 should succeed"
  fi
  PATH="$original_path"
  pass "200 response succeeds"
}

test_token_not_exposed_in_curl_argv() {
  source_reporter
  local mock_dir="${TEST_TMP}/mock-token-argv"
  mkdir -p "$mock_dir"

  cat > "${mock_dir}/curl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$(dirname "$0")/curl-args"
cat > "$(dirname "$0")/curl-stdin"
echo "200"
MOCK
  chmod +x "${mock_dir}/curl"

  local token_file="${mock_dir}/token"
  local token_value="secret-health-token"
  printf '%s\n' "$token_value" > "$token_file"

  local payload
  payload="$(build_test_payload)"
  local original_path="$PATH"
  PATH="${mock_dir}:$PATH"

  if ! _send_health_report "http://localhost/api/agent-health" "$payload" "$token_file" 2>/dev/null; then
    PATH="$original_path"
    fail "expected send with token file to succeed"
  fi
  PATH="$original_path"

  local args_file="${mock_dir}/curl-args"
  [ -f "$args_file" ] || fail "mock curl did not capture argv"
  if grep -Fq "$token_value" "$args_file"; then
    fail "token value leaked into curl argv"
  fi

  grep -Fxq '@-' "$args_file" || fail "expected curl argv to include '@-' header-stdin reference"

  local stdin_file="${mock_dir}/curl-stdin"
  [ -f "$stdin_file" ] || fail "mock curl did not capture stdin"
  local stdin_line
  stdin_line="$(cat "$stdin_file")"
  [ "$stdin_line" = "Authorization: Bearer ${token_value}" ] || fail "expected auth header on stdin"
  pass "token is passed via stdin and not exposed in curl argv"
}

test_response_400() {
  source_reporter
  local mock_curl
  mock_curl="$(make_mock_curl 400)"
  cp "$mock_curl" "$(dirname "$mock_curl")/curl"
  chmod +x "$(dirname "$mock_curl")/curl"

  local payload
  payload="$(build_test_payload)"
  local original_path="$PATH"
  PATH="$(dirname "$mock_curl"):$PATH"

  if _send_health_report "http://localhost/api/agent-health" "$payload" "" 2>/dev/null; then
    PATH="$original_path"
    fail "400 should fail without retry"
  fi
  PATH="$original_path"
  pass "400 response fails without retry"
}

test_response_401() {
  source_reporter
  local mock_curl
  mock_curl="$(make_mock_curl 401)"
  cp "$mock_curl" "$(dirname "$mock_curl")/curl"
  chmod +x "$(dirname "$mock_curl")/curl"

  local payload
  payload="$(build_test_payload)"
  local original_path="$PATH"
  PATH="$(dirname "$mock_curl"):$PATH"

  local stderr_output
  stderr_output="$(_send_health_report "http://localhost/api/agent-health" "$payload" "" 2>&1 || true)"
  PATH="$original_path"

  echo "$stderr_output" | grep -q "authentication failed" || fail "401 should log auth error"
  pass "401 response logs auth error"
}

test_response_413() {
  source_reporter
  local mock_curl
  mock_curl="$(make_mock_curl 413)"
  cp "$mock_curl" "$(dirname "$mock_curl")/curl"
  chmod +x "$(dirname "$mock_curl")/curl"

  local payload
  payload="$(build_test_payload)"
  local original_path="$PATH"
  PATH="$(dirname "$mock_curl"):$PATH"

  if _send_health_report "http://localhost/api/agent-health" "$payload" "" 2>/dev/null; then
    PATH="$original_path"
    fail "413 should fail"
  fi
  PATH="$original_path"
  pass "413 response fails without retry"
}

test_response_429() {
  source_reporter
  local mock_curl
  mock_curl="$(make_mock_curl 429)"
  cp "$mock_curl" "$(dirname "$mock_curl")/curl"
  chmod +x "$(dirname "$mock_curl")/curl"

  local payload
  payload="$(build_test_payload)"
  local original_path="$PATH"
  PATH="$(dirname "$mock_curl"):$PATH"

  local stderr_output
  stderr_output="$(_send_health_report "http://localhost/api/agent-health" "$payload" "" 2>&1 || true)"
  PATH="$original_path"

  echo "$stderr_output" | grep -q "rate limited" || fail "429 should log rate limit"
  pass "429 response skips retries"
}

test_response_5xx_retries() {
  source_reporter
  # Sequence: 500, 500, 200 (succeeds on third attempt)
  local mock_dir="${TEST_TMP}/mock-5xx"
  mkdir -p "$mock_dir"
  local counter_file="${mock_dir}/curl-call-count"
  printf '0' > "$counter_file"

  cat > "${mock_dir}/curl" <<'MOCK'
#!/usr/bin/env bash
COUNTER_FILE="$(dirname "$0")/curl-call-count"
count="$(cat "$COUNTER_FILE")"
count=$((count + 1))
printf '%d' "$count" > "$COUNTER_FILE"
if [ "$count" -le 2 ]; then
  echo "500"
else
  echo "200"
fi
MOCK
  chmod +x "${mock_dir}/curl"

  local payload
  payload="$(build_test_payload)"
  local original_path="$PATH"
  PATH="${mock_dir}:$PATH"

  # Override sleep to avoid delays in tests
  # shellcheck disable=SC2329  # invoked indirectly by _send_health_report
  _sleep_with_jitter() { :; }

  # shellcheck disable=SC2034  # read by sourced _send_health_report
  HEALTH_REPORT_MAX_RETRIES=2

  if ! _send_health_report "http://localhost/api/agent-health" "$payload" "" 2>/dev/null; then
    PATH="$original_path"
    fail "5xx should eventually succeed after retries"
  fi
  PATH="$original_path"

  local call_count
  call_count="$(cat "$counter_file")"
  [ "$call_count" -eq 3 ] || fail "expected 3 curl calls, got ${call_count}"
  pass "5xx retries and eventually succeeds"
}

test_response_5xx_gives_up() {
  source_reporter
  local mock_curl
  mock_curl="$(make_mock_curl 503)"
  cp "$mock_curl" "$(dirname "$mock_curl")/curl"
  chmod +x "$(dirname "$mock_curl")/curl"

  local payload
  payload="$(build_test_payload)"
  local original_path="$PATH"
  PATH="$(dirname "$mock_curl"):$PATH"

  # Override sleep to avoid delays
  # shellcheck disable=SC2329  # invoked indirectly by _send_health_report
  _sleep_with_jitter() { :; }

  # shellcheck disable=SC2034  # read by sourced _send_health_report
  HEALTH_REPORT_MAX_RETRIES=1

  if _send_health_report "http://localhost/api/agent-health" "$payload" "" 2>/dev/null; then
    PATH="$original_path"
    fail "persistent 5xx should fail after max retries"
  fi
  PATH="$original_path"
  pass "5xx gives up after max retries"
}

test_response_000_network_retry() {
  source_reporter
  # Regression: curl returns exit=7 with http_code="000" on connection refused.
  # Must trigger retry, not fall through to "unexpected response (000)".
  local mock_dir="${TEST_TMP}/mock-000"
  mkdir -p "$mock_dir"
  local counter_file="${mock_dir}/curl-call-count"
  printf '0' > "$counter_file"

  cat > "${mock_dir}/curl" <<'MOCK'
#!/usr/bin/env bash
COUNTER_FILE="$(dirname "$0")/curl-call-count"
count="$(cat "$COUNTER_FILE")"
count=$((count + 1))
printf '%d' "$count" > "$COUNTER_FILE"
if [ "$count" -le 2 ]; then
  # Simulate connection refused: exit 7, http_code "000"
  echo "000"
  exit 7
fi
echo "200"
MOCK
  chmod +x "${mock_dir}/curl"

  local payload
  payload="$(build_test_payload)"
  local original_path="$PATH"
  PATH="${mock_dir}:$PATH"

  # Override sleep to avoid delays
  # shellcheck disable=SC2329  # invoked indirectly by _send_health_report
  _sleep_with_jitter() { :; }

  # shellcheck disable=SC2034  # read by sourced _send_health_report
  HEALTH_REPORT_MAX_RETRIES=2

  if ! _send_health_report "http://localhost/api/agent-health" "$payload" "" 2>/dev/null; then
    PATH="$original_path"
    fail "000 network error should retry and eventually succeed"
  fi
  PATH="$original_path"

  local call_count
  call_count="$(cat "$counter_file")"
  [ "$call_count" -eq 3 ] || fail "expected 3 curl calls for 000 retry, got ${call_count}"
  pass "000 network error triggers retry (regression)"
}

# ── report_health_to_backend integration ─────────────────────────

test_skips_when_url_empty() {
  source_reporter
  HEALTH_REPORT_URL=""
  # Should return 0 without doing anything
  if ! report_health_to_backend "agent" "owner/repo" "" "run-1" "success" "10" "0" 2>/dev/null; then
    fail "should return 0 when URL is empty"
  fi
  pass "skips when HEALTH_REPORT_URL is empty"
}

test_sends_correct_payload() {
  source_reporter
  local mock_dir="${TEST_TMP}/mock-integration"
  mkdir -p "$mock_dir"

  # Mock curl that captures the payload
  local captured_file="${mock_dir}/captured-payload"
  cat > "${mock_dir}/curl" <<MOCK
#!/usr/bin/env bash
# Find the -d argument
while [ \$# -gt 0 ]; do
  case "\$1" in
    -d) shift; printf '%s' "\$1" > "${captured_file}"; shift ;;
    *) shift ;;
  esac
done
echo "200"
MOCK
  chmod +x "${mock_dir}/curl"

  local original_path="$PATH"
  PATH="${mock_dir}:$PATH"
  # shellcheck disable=SC2034  # read by sourced report_health_to_backend
  HEALTH_REPORT_URL="http://localhost/api/agent-health"

  report_health_to_backend "forager" "hivemoot/sandbox" "" "20260226-run-1" "success" "120" "0" "0" 2>/dev/null || true

  PATH="$original_path"

  if [ -f "$captured_file" ]; then
    local agent_val repo_val run_id_val outcome_val
    agent_val="$(jq -r '.agent_id' "$captured_file")"
    repo_val="$(jq -r '.repo' "$captured_file")"
    run_id_val="$(jq -r '.run_id' "$captured_file")"
    outcome_val="$(jq -r '.outcome' "$captured_file")"
    [ "$agent_val" = "forager" ] || fail "expected agent_id=forager, got ${agent_val}"
    [ "$repo_val" = "hivemoot/sandbox" ] || fail "expected repo=hivemoot/sandbox, got ${repo_val}"
    [ "$run_id_val" = "20260226-run-1" ] || fail "expected run_id=20260226-run-1, got ${run_id_val}"
    [ "$outcome_val" = "success" ] || fail "expected outcome=success, got ${outcome_val}"
  else
    fail "payload was not captured"
  fi
  pass "sends correct payload fields"
}

test_sends_optional_fields_on_failure() {
  source_reporter
  local mock_dir="${TEST_TMP}/mock-failure"
  mkdir -p "$mock_dir"

  local captured_file="${mock_dir}/captured-payload"
  cat > "${mock_dir}/curl" <<MOCK
#!/usr/bin/env bash
while [ \$# -gt 0 ]; do
  case "\$1" in
    -d) shift; printf '%s' "\$1" > "${captured_file}"; shift ;;
    *) shift ;;
  esac
done
echo "200"
MOCK
  chmod +x "${mock_dir}/curl"

  local original_path="$PATH"
  PATH="${mock_dir}:$PATH"
  # shellcheck disable=SC2034  # read by sourced report_health_to_backend
  HEALTH_REPORT_URL="http://localhost/api/agent-health"

  report_health_to_backend "guard" "hivemoot/bot" "" "20260226-run-2" "failure" "60" "3" "1" "provider timeout" 2>/dev/null || true

  PATH="$original_path"

  if [ -f "$captured_file" ]; then
    local exit_val error_val
    exit_val="$(jq '.exit_code' "$captured_file")"
    error_val="$(jq -r '.error' "$captured_file")"
    [ "$exit_val" = "1" ] || fail "expected exit_code=1, got ${exit_val}"
    [ "$error_val" = "provider timeout" ] || fail "expected error='provider timeout', got '${error_val}'"
  else
    fail "payload was not captured"
  fi
  pass "includes exit_code and error on failure"
}

test_sends_next_run_at_when_provided() {
  source_reporter
  local mock_dir="${TEST_TMP}/mock-next-run"
  mkdir -p "$mock_dir"

  local captured_file="${mock_dir}/captured-payload"
  cat > "${mock_dir}/curl" <<MOCK
#!/usr/bin/env bash
while [ \$# -gt 0 ]; do
  case "\$1" in
    -d) shift; printf '%s' "\$1" > "${captured_file}"; shift ;;
    *) shift ;;
  esac
done
echo "200"
MOCK
  chmod +x "${mock_dir}/curl"

  local original_path="$PATH"
  PATH="${mock_dir}:$PATH"
  # shellcheck disable=SC2034  # read by sourced report_health_to_backend
  HEALTH_REPORT_URL="http://localhost/api/agent-health"

  report_health_to_backend "forager" "hivemoot/sandbox" "" "20260226-run-3" "success" "120" "0" "0" "" "2026-02-27T02:00:00Z" 2>/dev/null || true

  PATH="$original_path"

  if [ -f "$captured_file" ]; then
    local next_val
    next_val="$(jq -r '.next_run_at' "$captured_file")"
    [ "$next_val" = "2026-02-27T02:00:00Z" ] || fail "expected next_run_at='2026-02-27T02:00:00Z', got '${next_val}'"
  else
    fail "payload was not captured"
  fi
  pass "includes next_run_at in payload when provided"
}

test_omits_next_run_at_when_empty() {
  source_reporter
  local mock_dir="${TEST_TMP}/mock-no-next-run"
  mkdir -p "$mock_dir"

  local captured_file="${mock_dir}/captured-payload"
  cat > "${mock_dir}/curl" <<MOCK
#!/usr/bin/env bash
while [ \$# -gt 0 ]; do
  case "\$1" in
    -d) shift; printf '%s' "\$1" > "${captured_file}"; shift ;;
    *) shift ;;
  esac
done
echo "200"
MOCK
  chmod +x "${mock_dir}/curl"

  local original_path="$PATH"
  PATH="${mock_dir}:$PATH"
  # shellcheck disable=SC2034  # read by sourced report_health_to_backend
  HEALTH_REPORT_URL="http://localhost/api/agent-health"

  report_health_to_backend "forager" "hivemoot/sandbox" "" "20260226-run-4" "success" "120" "0" "0" "" "" 2>/dev/null || true

  PATH="$original_path"

  if [ -f "$captured_file" ]; then
    local has_next
    has_next="$(jq 'has("next_run_at")' "$captured_file")"
    [ "$has_next" = "false" ] || fail "expected next_run_at to be absent when not provided"
  else
    fail "payload was not captured"
  fi
  pass "omits next_run_at from payload when empty"
}

# ── run all tests ────────────────────────────────────────────────

echo "Running health reporter tests"
echo ""

setup

echo "  update_agent_stats:"
run_test test_stats_creates_new_file
run_test test_stats_increments_run_count
run_test test_stats_increments_error_count
run_test test_stats_has_updated_at
echo ""

echo "  Payload builder:"
run_test test_payload_has_required_fields
run_test test_payload_field_count
run_test test_payload_optional_exit_code
run_test test_payload_optional_error
run_test test_payload_omits_empty_optionals
run_test test_payload_optional_next_run_at
run_test test_payload_omits_empty_next_run_at
echo ""

echo "  Validation — required fields:"
run_test test_validates_missing_agent_id
run_test test_validates_missing_repo
run_test test_validates_missing_run_id
run_test test_validates_extra_fields
run_test test_valid_payload_passes
run_test test_valid_payload_with_optionals_passes
run_test test_valid_payload_with_next_run_at_passes
echo ""

echo "  Validation — enums:"
run_test test_validates_invalid_outcome_enum
run_test test_validates_valid_outcome_values
run_test test_validates_skipped_not_valid_outcome
echo ""

echo "  Validation — numerics:"
run_test test_validates_negative_consecutive_failures
run_test test_validates_negative_duration_secs
echo ""

echo "  Validation — size budget:"
run_test test_validates_size_budget
echo ""

echo "  Response handling:"
run_test test_response_200
run_test test_token_not_exposed_in_curl_argv
run_test test_response_400
run_test test_response_401
run_test test_response_413
run_test test_response_429
run_test test_response_5xx_retries
run_test test_response_5xx_gives_up
run_test test_response_000_network_retry
echo ""

echo "  Integration:"
run_test test_skips_when_url_empty
run_test test_sends_correct_payload
run_test test_sends_optional_fields_on_failure
run_test test_sends_next_run_at_when_provided
run_test test_omits_next_run_at_when_empty
echo ""

teardown

echo "PASS: ${TESTS_PASSED}/${TESTS_RUN} health reporter tests"
