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

# Create a mock curl that counts invocations and returns different codes.
make_mock_curl_sequence() {
  local mock_path="${TEST_TMP}/mock-curl-seq"
  local counter_file="${TEST_TMP}/curl-call-count"
  printf '0' > "$counter_file"

  # Write the response codes to a file, one per line
  local codes_file="${TEST_TMP}/curl-codes"
  local code
  for code in "$@"; do
    echo "$code" >> "$codes_file"
  done

  cat > "$mock_path" <<'MOCK'
#!/usr/bin/env bash
COUNTER_FILE="$(dirname "$0")/curl-call-count"
CODES_FILE="$(dirname "$0")/curl-codes"
count="$(cat "$COUNTER_FILE")"
count=$((count + 1))
printf '%d' "$count" > "$COUNTER_FILE"
# Get the code for this call (1-indexed line)
code="$(sed -n "${count}p" "$CODES_FILE")"
if [ -z "$code" ]; then
  # Past the end of sequence — return last code
  code="$(tail -n 1 "$CODES_FILE")"
fi
echo "$code"
MOCK
  chmod +x "$mock_path"
  printf '%s' "$mock_path"
}

# Build a valid payload for testing
build_test_payload() {
  source_reporter
  _build_health_payload \
    "test-agent" "hivemoot" "active" "2026-02-26T12:00:00Z" \
    "success" "42" "3" "0" "1234" "hivemoot/sandbox"
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

test_payload_has_exactly_required_fields() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  local actual_fields
  actual_fields="$(printf '%s' "$payload" | jq -r 'keys | .[]' | sort | tr '\n' ' ' | sed 's/ $//')"
  local expected="agent_id consecutive_failures current_repos duration_secs error_count installation last_outcome last_run run_count status"
  [ "$actual_fields" = "$expected" ] || fail "field mismatch: expected [${expected}], got [${actual_fields}]"
  pass "payload has exactly required fields"
}

test_payload_no_extra_fields() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  local field_count
  field_count="$(printf '%s' "$payload" | jq 'keys | length')"
  [ "$field_count" -eq 10 ] || fail "expected exactly 10 fields, got ${field_count}"
  pass "payload has no extra fields"
}

test_payload_current_repos_is_array() {
  source_reporter
  local payload
  payload="$(_build_health_payload "a" "b" "active" "2026-01-01T00:00:00Z" "success" "1" "0" "0" "10" "owner/repo")"
  local repo_type
  repo_type="$(printf '%s' "$payload" | jq -r '.current_repos | type')"
  [ "$repo_type" = "array" ] || fail "expected current_repos to be array, got ${repo_type}"
  local first
  first="$(printf '%s' "$payload" | jq -r '.current_repos[0]')"
  [ "$first" = "owner/repo" ] || fail "expected first repo to be owner/repo, got ${first}"
  pass "payload current_repos is array"
}

test_payload_empty_repos() {
  source_reporter
  local payload
  payload="$(_build_health_payload "a" "b" "active" "2026-01-01T00:00:00Z" "success" "1" "0" "0" "10" "")"
  local repo_count
  repo_count="$(printf '%s' "$payload" | jq '.current_repos | length')"
  [ "$repo_count" -eq 0 ] || fail "expected empty repos array, got ${repo_count} entries"
  pass "payload handles empty repos"
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

test_validates_invalid_status_enum() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.status = "running"')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject invalid status"
  fi
  pass "rejects invalid status enum"
}

test_validates_valid_status_values() {
  source_reporter
  local payload_base
  payload_base="$(build_test_payload)"
  local status
  for status in active idle error offline; do
    local payload
    payload="$(printf '%s' "$payload_base" | jq --arg s "$status" '.status = $s')"
    if ! _validate_health_payload "$payload" 2>/dev/null; then
      fail "validation should accept status=${status}"
    fi
  done
  pass "accepts all valid status values"
}

test_validates_invalid_outcome_enum() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.last_outcome = "crashed"')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject invalid last_outcome"
  fi
  pass "rejects invalid last_outcome enum"
}

test_validates_timeout_not_valid_outcome() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.last_outcome = "timeout"')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject 'timeout' — not in backend contract"
  fi
  pass "rejects 'timeout' as last_outcome (not in contract)"
}

test_validates_valid_outcome_values() {
  source_reporter
  local payload_base
  payload_base="$(build_test_payload)"
  local outcome
  for outcome in success failure skipped; do
    local payload
    payload="$(printf '%s' "$payload_base" | jq --arg o "$outcome" '.last_outcome = $o')"
    if ! _validate_health_payload "$payload" 2>/dev/null; then
      fail "validation should accept last_outcome=${outcome}"
    fi
  done
  pass "accepts all valid last_outcome values"
}

test_validates_negative_run_count() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.run_count = -1')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject negative run_count"
  fi
  pass "rejects negative run_count"
}

test_validates_negative_error_count() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.error_count = -5')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject negative error_count"
  fi
  pass "rejects negative error_count"
}

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

test_validates_malformed_repo() {
  source_reporter
  local payload
  payload="$(build_test_payload)"
  payload="$(printf '%s' "$payload" | jq '.current_repos = ["not-a-repo"]')"
  if _validate_health_payload "$payload" 2>/dev/null; then
    fail "validation should reject malformed repo"
  fi
  pass "rejects malformed current_repos entry"
}

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

# ── installation derivation tests ────────────────────────────────

test_installation_from_target_repo() {
  source_reporter
  local result
  result="$(_resolve_installation "hivemoot/sandbox")"
  [ "$result" = "hivemoot" ] || fail "expected 'hivemoot', got '${result}'"
  pass "installation derived from TARGET_REPO owner"
}

test_installation_override() {
  source_reporter
  local result
  # shellcheck disable=SC2034  # HIVEMOOT_INSTALLATION is read by the sourced _resolve_installation
  HIVEMOOT_INSTALLATION="custom-org" result="$(_resolve_installation "hivemoot/sandbox")"
  [ "$result" = "custom-org" ] || fail "expected 'custom-org', got '${result}'"
  pass "HIVEMOOT_INSTALLATION overrides derived value"
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
  local stats_file="${TEST_TMP}/stats-skip.json"
  printf '{"run_count":1,"error_count":0,"updated_at":"2026-01-01T00:00:00Z"}\n' > "$stats_file"
  # Should return 0 without doing anything
  if ! report_health_to_backend "agent" "owner/repo" "" "success" "10" "0" "$stats_file" 2>/dev/null; then
    fail "should return 0 when URL is empty"
  fi
  pass "skips when HEALTH_REPORT_URL is empty"
}

test_status_derives_active_on_success() {
  source_reporter
  local mock_dir="${TEST_TMP}/mock-status-active"
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

  local stats_file="${TEST_TMP}/stats-active.json"
  printf '{"run_count":5,"error_count":0,"updated_at":"2026-01-01T00:00:00Z"}\n' > "$stats_file"

  local original_path="$PATH"
  PATH="${mock_dir}:$PATH"
  # shellcheck disable=SC2034  # read by sourced report_health_to_backend
  HEALTH_REPORT_URL="http://localhost/api/agent-health"

  report_health_to_backend "agent" "hivemoot/sandbox" "" "success" "10" "0" "$stats_file" 2>/dev/null || true

  PATH="$original_path"

  if [ -f "$captured_file" ]; then
    local status_val
    status_val="$(jq -r '.status' "$captured_file")"
    [ "$status_val" = "active" ] || fail "expected status=active, got ${status_val}"
  else
    fail "payload was not captured"
  fi
  pass "status is 'active' on success"
}

test_status_derives_error_on_failure_streak() {
  source_reporter
  local mock_dir="${TEST_TMP}/mock-status-error"
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

  local stats_file="${TEST_TMP}/stats-error.json"
  printf '{"run_count":10,"error_count":3,"updated_at":"2026-01-01T00:00:00Z"}\n' > "$stats_file"

  local original_path="$PATH"
  PATH="${mock_dir}:$PATH"
  # shellcheck disable=SC2034  # read by sourced report_health_to_backend
  HEALTH_REPORT_URL="http://localhost/api/agent-health"

  report_health_to_backend "agent" "hivemoot/sandbox" "" "failure" "10" "3" "$stats_file" 2>/dev/null || true

  PATH="$original_path"

  if [ -f "$captured_file" ]; then
    local status_val
    status_val="$(jq -r '.status' "$captured_file")"
    [ "$status_val" = "error" ] || fail "expected status=error, got ${status_val}"
  else
    fail "payload was not captured"
  fi
  pass "status is 'error' on failure streak"
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
run_test test_payload_has_exactly_required_fields
run_test test_payload_no_extra_fields
run_test test_payload_current_repos_is_array
run_test test_payload_empty_repos
echo ""

echo "  Validation — required fields:"
run_test test_validates_missing_agent_id
run_test test_validates_extra_fields
run_test test_valid_payload_passes
echo ""

echo "  Validation — enums:"
run_test test_validates_invalid_status_enum
run_test test_validates_valid_status_values
run_test test_validates_invalid_outcome_enum
run_test test_validates_timeout_not_valid_outcome
run_test test_validates_valid_outcome_values
echo ""

echo "  Validation — numerics:"
run_test test_validates_negative_run_count
run_test test_validates_negative_error_count
run_test test_validates_negative_consecutive_failures
run_test test_validates_negative_duration_secs
echo ""

echo "  Validation — repo format:"
run_test test_validates_malformed_repo
echo ""

echo "  Validation — size budget:"
run_test test_validates_size_budget
echo ""

echo "  Installation derivation:"
run_test test_installation_from_target_repo
run_test test_installation_override
echo ""

echo "  Response handling:"
run_test test_response_200
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
run_test test_status_derives_active_on_success
run_test test_status_derives_error_on_failure_streak
echo ""

teardown

echo "PASS: ${TESTS_PASSED}/${TESTS_RUN} health reporter tests"
