#!/usr/bin/env bash
set -euo pipefail

# Test suite for token-extractor.sh extraction functions.
# Uses fixture NDJSON log snippets — no real provider runs required.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TESTS_RUN=0
TESTS_PASSED=0
TEST_TMP=""

setup() {
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "${TEST_TMP}"
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
  setup
  "$@"
  teardown
}

# Source the extractor library (not a full script execution).
source_extractor() {
  unset HIVEMOOT_TOKEN_EXTRACTOR_LOADED 2>/dev/null || true
  # shellcheck source=scripts/token-extractor.sh
  . "${SCRIPT_DIR}/token-extractor.sh"
}

# ── Claude extraction tests ───────────────────────────────────────

test_claude_extracts_token_sums_from_model_usage() {
  source_extractor
  # Two-model session: sonnet for output, haiku for bulk input.
  cat > "${TEST_TMP}/run.ndjson" <<'EOF'
{"type":"assistant","message":{}}
{"type":"result","subtype":"success","is_error":false,"duration_ms":5000,"num_turns":3,"total_cost_usd":1.23,"modelUsage":{"claude-sonnet-4-6":{"input_tokens":80,"output_tokens":40,"cache_read_input_tokens":200,"cache_creation_input_tokens":100,"cost_usd":1.00},"claude-haiku-4-5-20251001":{"input_tokens":20,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":50,"cost_usd":0.23}}}
EOF
  local result
  result="$(extract_claude_token_usage_from_log "${TEST_TMP}/run.ndjson")"
  [ -n "$result" ] || fail "expected non-empty result"

  local input_tokens output_tokens cache_read cache_creation cost num_turns
  input_tokens="$(printf '%s' "$result" | jq '.input_tokens')"
  output_tokens="$(printf '%s' "$result" | jq '.output_tokens')"
  cache_read="$(printf '%s' "$result" | jq '.cache_read_input_tokens')"
  cache_creation="$(printf '%s' "$result" | jq '.cache_creation_input_tokens')"
  cost="$(printf '%s' "$result" | jq '.cost_usd')"
  num_turns="$(printf '%s' "$result" | jq '.num_turns')"

  [ "$input_tokens" = "100" ]   || fail "input_tokens: expected 100, got ${input_tokens}"
  [ "$output_tokens" = "50" ]   || fail "output_tokens: expected 50, got ${output_tokens}"
  [ "$cache_read" = "200" ]     || fail "cache_read_input_tokens: expected 200, got ${cache_read}"
  [ "$cache_creation" = "150" ] || fail "cache_creation_input_tokens: expected 150, got ${cache_creation}"
  [ "$cost" = "1.23" ]          || fail "cost_usd: expected 1.23, got ${cost}"
  [ "$num_turns" = "3" ]        || fail "num_turns: expected 3, got ${num_turns}"

  pass "claude: sums input/output/cache tokens from modelUsage across all models"
}

test_claude_model_breakdown_includes_all_fields() {
  source_extractor
  cat > "${TEST_TMP}/run.ndjson" <<'EOF'
{"type":"result","subtype":"success","num_turns":1,"total_cost_usd":1.00,"modelUsage":{"claude-sonnet-4-6":{"input_tokens":80,"output_tokens":40,"cache_read_input_tokens":200,"cache_creation_input_tokens":100,"cost_usd":1.00}}}
EOF
  local result
  result="$(extract_claude_token_usage_from_log "${TEST_TMP}/run.ndjson")"
  [ -n "$result" ] || fail "expected non-empty result"

  local bd_input bd_cache_read bd_cost_ok
  bd_input="$(printf '%s' "$result" | jq '.model_breakdown["claude-sonnet-4-6"].input_tokens')"
  bd_cache_read="$(printf '%s' "$result" | jq '.model_breakdown["claude-sonnet-4-6"].cache_read_input_tokens')"
  # Use jq for numeric comparison to avoid float representation differences (1 vs 1.0 vs 1.00).
  bd_cost_ok="$(printf '%s' "$result" | jq '.model_breakdown["claude-sonnet-4-6"].cost_usd == 1.0')"

  [ "$bd_input" = "80" ]       || fail "model_breakdown input_tokens: expected 80, got ${bd_input}"
  [ "$bd_cache_read" = "200" ] || fail "model_breakdown cache_read: expected 200, got ${bd_cache_read}"
  [ "$bd_cost_ok" = "true" ]   || fail "model_breakdown cost_usd: expected 1.0"

  pass "claude: model_breakdown includes cache and cost fields per model"
}

test_claude_uses_cost_usd_key_not_total() {
  source_extractor
  cat > "${TEST_TMP}/run.ndjson" <<'EOF'
{"type":"result","subtype":"success","num_turns":1,"total_cost_usd":2.50,"modelUsage":{"claude-sonnet-4-6":{"input_tokens":10,"output_tokens":5}}}
EOF
  local result
  result="$(extract_claude_token_usage_from_log "${TEST_TMP}/run.ndjson")"
  [ -n "$result" ] || fail "expected non-empty result"

  # Must use cost_usd, not total_cost_usd, as the payload key.
  local has_cost_usd has_total_cost_usd
  has_cost_usd="$(printf '%s' "$result" | jq 'has("cost_usd")')"
  has_total_cost_usd="$(printf '%s' "$result" | jq 'has("total_cost_usd")')"

  [ "$has_cost_usd" = "true" ]       || fail "expected cost_usd key in output"
  [ "$has_total_cost_usd" = "false" ] || fail "must not use total_cost_usd as payload key"

  pass "claude: output uses cost_usd key (not total_cost_usd)"
}

test_claude_no_result_event_returns_empty() {
  source_extractor
  cat > "${TEST_TMP}/run.ndjson" <<'EOF'
{"type":"assistant","message":{}}
{"type":"text","text":"hello"}
EOF
  local result
  result="$(extract_claude_token_usage_from_log "${TEST_TMP}/run.ndjson")"
  [ -z "$result" ] || fail "expected empty result when no result event, got: ${result}"
  pass "claude: returns empty when no result event present"
}

test_claude_missing_file_returns_empty() {
  source_extractor
  local result
  result="$(extract_claude_token_usage_from_log "${TEST_TMP}/nonexistent.ndjson")"
  [ -z "$result" ] || fail "expected empty for missing file, got: ${result}"
  pass "claude: returns empty for missing log file"
}

test_claude_empty_file_returns_empty() {
  source_extractor
  : > "${TEST_TMP}/empty.ndjson"
  local result
  result="$(extract_claude_token_usage_from_log "${TEST_TMP}/empty.ndjson")"
  [ -z "$result" ] || fail "expected empty for empty log, got: ${result}"
  pass "claude: returns empty for empty log file"
}

# ── Codex extraction tests ────────────────────────────────────────

test_codex_sums_across_all_turn_completed_events() {
  source_extractor
  cat > "${TEST_TMP}/run.ndjson" <<'EOF'
{"type":"turn.started","turn_id":"t1"}
{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20,"cached_input_tokens":50}}
{"type":"turn.started","turn_id":"t2"}
{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":40,"cached_input_tokens":80}}
EOF
  local result
  result="$(extract_codex_token_usage_from_log "${TEST_TMP}/run.ndjson")"
  [ -n "$result" ] || fail "expected non-empty result"

  local input_tokens output_tokens cache_read num_turns
  input_tokens="$(printf '%s' "$result" | jq '.input_tokens')"
  output_tokens="$(printf '%s' "$result" | jq '.output_tokens')"
  cache_read="$(printf '%s' "$result" | jq '.cache_read_input_tokens')"
  num_turns="$(printf '%s' "$result" | jq '.num_turns')"

  [ "$input_tokens" = "300" ]  || fail "input_tokens: expected 300, got ${input_tokens}"
  [ "$output_tokens" = "60" ]  || fail "output_tokens: expected 60, got ${output_tokens}"
  [ "$cache_read" = "130" ]    || fail "cache_read_input_tokens: expected 130, got ${cache_read}"
  [ "$num_turns" = "2" ]       || fail "num_turns: expected 2, got ${num_turns}"

  pass "codex: sums tokens across all turn.completed events"
}

test_codex_single_turn_returns_correct_counts() {
  source_extractor
  cat > "${TEST_TMP}/run.ndjson" <<'EOF'
{"type":"turn.completed","usage":{"input_tokens":500,"output_tokens":75,"cached_input_tokens":0}}
EOF
  local result
  result="$(extract_codex_token_usage_from_log "${TEST_TMP}/run.ndjson")"
  [ -n "$result" ] || fail "expected non-empty result"

  local num_turns
  num_turns="$(printf '%s' "$result" | jq '.num_turns')"
  [ "$num_turns" = "1" ] || fail "num_turns: expected 1, got ${num_turns}"

  pass "codex: single turn.completed gives num_turns=1"
}

test_codex_no_turn_completed_returns_empty() {
  source_extractor
  cat > "${TEST_TMP}/run.ndjson" <<'EOF'
{"type":"turn.started","turn_id":"t1"}
{"type":"text","content":"hello"}
EOF
  local result
  result="$(extract_codex_token_usage_from_log "${TEST_TMP}/run.ndjson")"
  [ -z "$result" ] || fail "expected empty when no turn.completed events, got: ${result}"
  pass "codex: returns empty when no turn.completed events"
}

test_codex_missing_file_returns_empty() {
  source_extractor
  local result
  result="$(extract_codex_token_usage_from_log "${TEST_TMP}/nonexistent.ndjson")"
  [ -z "$result" ] || fail "expected empty for missing file, got: ${result}"
  pass "codex: returns empty for missing log file"
}

# ── run all tests ─────────────────────────────────────────────────

echo "Running token extractor tests"
echo ""

echo "  Claude — token extraction:"
run_test test_claude_extracts_token_sums_from_model_usage
run_test test_claude_model_breakdown_includes_all_fields
run_test test_claude_uses_cost_usd_key_not_total
run_test test_claude_no_result_event_returns_empty
run_test test_claude_missing_file_returns_empty
run_test test_claude_empty_file_returns_empty
echo ""

echo "  Codex — token extraction:"
run_test test_codex_sums_across_all_turn_completed_events
run_test test_codex_single_turn_returns_correct_counts
run_test test_codex_no_turn_completed_returns_empty
run_test test_codex_missing_file_returns_empty
echo ""

echo "Passed ${TESTS_PASSED}/${TESTS_RUN} tests"
[ "$TESTS_PASSED" -eq "$TESTS_RUN" ] || exit 1
