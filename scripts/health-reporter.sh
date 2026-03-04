#!/usr/bin/env bash
set -euo pipefail

# health-reporter.sh — sourced library for V2 health reporting.
# Sends terminal run state to the backend via POST /api/agent-health.
# Best-effort: never blocks or fails the main run path.
#
# Contract version: hivemoot/hivemoot /api/agent-health v1

if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  echo "scripts/health-reporter.sh is a library and should be sourced, not executed." >&2
  exit 0
fi

if [ -n "${HIVEMOOT_HEALTH_REPORTER_LOADED:-}" ]; then
  return 0
fi
HIVEMOOT_HEALTH_REPORTER_LOADED=1

# Configurable via environment. Defaults match .env.example.
HEALTH_REPORT_URL="${HEALTH_REPORT_URL:-}"
HEALTH_REPORT_TIMEOUT_SECS="${HEALTH_REPORT_TIMEOUT_SECS:-10}"
HEALTH_REPORT_MAX_RETRIES="${HEALTH_REPORT_MAX_RETRIES:-2}"

# Payload size budget (bytes). Reject locally before sending.
_HEALTH_PAYLOAD_MAX_BYTES=10240

# Valid enum values for local validation.
_VALID_OUTCOMES="success failure timeout"

# Allowed payload fields (sorted). Must match backend HealthReport.
_ALLOWED_FIELDS="agent_id consecutive_failures duration_secs error exit_code next_run_at outcome repo run_id"

# Build the JSON payload for the health report.
# Requires jq.
_build_health_payload() {
  local agent_id="$1"
  local repo="$2"
  local run_id="$3"
  local outcome="$4"
  local duration_secs="$5"
  local consecutive_failures="$6"
  local exit_code="${7:-}"
  local error_msg="${8:-}"
  local next_run_at="${9:-}"

  local jq_args=(
    -n
    --arg agent_id "$agent_id"
    --arg repo "$repo"
    --arg run_id "$run_id"
    --arg outcome "$outcome"
    --argjson duration_secs "$duration_secs"
    --argjson consecutive_failures "$consecutive_failures"
  )

  # shellcheck disable=SC2016  # jq placeholders ($agent_id, etc.) must stay literal in the jq program string.
  local jq_filter='{
    agent_id: $agent_id,
    repo: $repo,
    run_id: $run_id,
    outcome: $outcome,
    duration_secs: $duration_secs,
    consecutive_failures: $consecutive_failures
  }'

  # Optional fields: only include when non-empty.
  if [ -n "$exit_code" ]; then
    jq_args+=(--argjson exit_code "$exit_code")
    jq_filter="${jq_filter} + {exit_code: \$exit_code}"
  fi
  if [ -n "$error_msg" ]; then
    jq_args+=(--arg error "$error_msg")
    jq_filter="${jq_filter} + {error: \$error}"
  fi
  if [ -n "$next_run_at" ]; then
    jq_args+=(--arg next_run_at "$next_run_at")
    jq_filter="${jq_filter} + {next_run_at: \$next_run_at}"
  fi

  jq "${jq_args[@]}" "$jq_filter"
}

# Validate the payload before sending.
# Returns 0 on success, 1 on validation failure (with message on stderr).
_validate_health_payload() {
  local payload="$1"

  # Required string fields must be non-empty
  local field
  for field in agent_id repo run_id outcome; do
    local value
    value="$(printf '%s' "$payload" | jq -r ".$field // empty")"
    if [ -z "$value" ]; then
      echo "health-report: validation failed — missing required field: ${field}" >&2
      return 1
    fi
  done

  # Enum: outcome
  local outcome_val
  outcome_val="$(printf '%s' "$payload" | jq -r '.outcome')"
  local valid=0
  local s
  for s in $_VALID_OUTCOMES; do
    if [ "$outcome_val" = "$s" ]; then valid=1; break; fi
  done
  if [ "$valid" -eq 0 ]; then
    echo "health-report: validation failed — invalid outcome: ${outcome_val} (expected: ${_VALID_OUTCOMES})" >&2
    return 1
  fi

  # Non-negative numeric fields
  local num_field
  for num_field in consecutive_failures duration_secs; do
    local num_val
    num_val="$(printf '%s' "$payload" | jq -r ".$num_field")"
    if ! printf '%s' "$num_val" | grep -Eq '^[0-9]+$'; then
      echo "health-report: validation failed — ${num_field} must be a non-negative integer: ${num_val}" >&2
      return 1
    fi
  done

  # Size budget
  local payload_size
  payload_size="$(printf '%s' "$payload" | wc -c | tr -d ' ')"
  if [ "$payload_size" -gt "$_HEALTH_PAYLOAD_MAX_BYTES" ]; then
    echo "health-report: validation failed — payload too large: ${payload_size} bytes (max ${_HEALTH_PAYLOAD_MAX_BYTES})" >&2
    return 1
  fi

  # Verify no unexpected fields (contract guardrail)
  local actual_fields
  actual_fields="$(printf '%s' "$payload" | jq -r 'keys | .[]' | sort | tr '\n' ' ' | sed 's/ $//')"
  for field in $actual_fields; do
    local found=0
    local allowed
    for allowed in $_ALLOWED_FIELDS; do
      if [ "$field" = "$allowed" ]; then found=1; break; fi
    done
    if [ "$found" -eq 0 ]; then
      echo "health-report: validation failed — unexpected field: ${field}" >&2
      return 1
    fi
  done

  return 0
}

# Send health report with retry logic for 5xx/network errors.
# Args: url, payload, token (raw token or token file path)
_send_health_report() {
  local url="$1"
  local payload="$2"
  local token_input="${3:-}"
  local max_retries="${HEALTH_REPORT_MAX_RETRIES}"
  local timeout="${HEALTH_REPORT_TIMEOUT_SECS}"
  local attempt=0
  local backoff=1

  while [ "$attempt" -le "$max_retries" ]; do
    local http_code=""
    local curl_exit=0

    local curl_args=(-s -o /dev/null -w '%{http_code}' --max-time "$timeout")
    curl_args+=(-X POST -H 'Content-Type: application/json')

    # Auth header: pass via stdin (`-H @-`) so the token never appears in
    # process argv and does not need to be staged in a temporary file.
    local use_auth_header_stdin=0
    local token_value=""
    if [ -n "$token_input" ]; then
      if [ -f "$token_input" ]; then
        if ! token_value="$(tr -d '\r\n' < "$token_input")"; then
          echo "health-report: failed to read token file: ${token_input}" >&2
          return 1
        fi
      else
        token_value="$token_input"
      fi
    fi
    if [ -n "$token_value" ]; then
      use_auth_header_stdin=1
    fi

    curl_args+=(-d "$payload" "$url")
    if [ "$use_auth_header_stdin" -eq 1 ]; then
      http_code="$(printf 'Authorization: Bearer %s\n' "$token_value" | curl "${curl_args[@]}" -H @-)" || curl_exit=$?
    else
      http_code="$(curl "${curl_args[@]}")" || curl_exit=$?
    fi

    # Network error: curl exits non-zero with http_code empty or "000"
    # (connection refused, DNS failure, timeout before response, etc.)
    if [ "$curl_exit" -ne 0 ] && { [ -z "$http_code" ] || [ "$http_code" = "000" ]; }; then
      echo "health-report: network error (curl exit=${curl_exit}), attempt $((attempt + 1))/$((max_retries + 1))" >&2
      attempt=$((attempt + 1))
      if [ "$attempt" -gt "$max_retries" ]; then
        echo "health-report: gave up after $((max_retries + 1)) attempts" >&2
        return 1
      fi
      _sleep_with_jitter "$backoff"
      backoff=$((backoff * 2))
      [ "$backoff" -gt 4 ] && backoff=4
      continue
    fi

    case "$http_code" in
      200)
        echo "health-report: sent successfully" >&2
        return 0
        ;;
      400)
        echo "health-report: rejected by backend (400 Bad Request) — check payload format" >&2
        return 1
        ;;
      401)
        echo "health-report: authentication failed (401) — check token and installation access" >&2
        return 1
        ;;
      413)
        echo "health-report: payload too large (413) — reduce payload size" >&2
        return 1
        ;;
      429)
        echo "health-report: rate limited (429) — skipping remaining retries" >&2
        return 1
        ;;
      5*)
        echo "health-report: server error (${http_code}), attempt $((attempt + 1))/$((max_retries + 1))" >&2
        attempt=$((attempt + 1))
        if [ "$attempt" -gt "$max_retries" ]; then
          echo "health-report: gave up after $((max_retries + 1)) attempts" >&2
          return 1
        fi
        _sleep_with_jitter "$backoff"
        backoff=$((backoff * 2))
        [ "$backoff" -gt 4 ] && backoff=4
        ;;
      *)
        echo "health-report: unexpected response (${http_code})" >&2
        return 1
        ;;
    esac
  done

  return 1
}

# Sleep with ±25% jitter for bounded backoff.
_sleep_with_jitter() {
  local base="$1"
  # Use $RANDOM (0–32767) to compute jitter: ±25% of base
  local jitter_range=$((base * 1000 / 4))
  if [ "$jitter_range" -le 0 ]; then
    sleep "$base"
    return
  fi
  local jitter_ms=$(( (RANDOM % (jitter_range * 2 + 1)) - jitter_range ))
  local sleep_ms=$(( base * 1000 + jitter_ms ))
  [ "$sleep_ms" -lt 100 ] && sleep_ms=100
  # Convert ms to seconds with decimal (awk avoids bc dependency)
  local sleep_secs
  sleep_secs="$(awk "BEGIN { printf \"%.2f\", ${sleep_ms} / 1000 }")"
  sleep "$sleep_secs"
}

# Main entry point. Best-effort — returns 0 even on failure when called
# with || true from run-once.sh.
#
# Args:
#   agent_id             — agent identifier (e.g. "forager")
#   repo                 — current repo in owner/repo format
#   token                — bearer token (may be empty)
#   run_id               — unique run identifier for idempotency
#   outcome              — "success" | "failure" | "timeout"
#   duration_secs        — run duration in seconds
#   consecutive_failures — current streak of consecutive failures
#   exit_code            — process exit code (optional)
#   error                — error message (optional)
#   next_run_at          — ISO 8601 timestamp of next scheduled run (optional)
report_health_to_backend() {
  local agent_id="$1"
  local repo="$2"
  local token="${3:-}"
  local run_id="$4"
  local outcome="$5"
  local duration_secs="$6"
  local consecutive_failures="${7:-0}"
  local exit_code="${8:-}"
  local error_msg="${9:-}"
  local next_run_at="${10:-}"

  if [ -z "$HEALTH_REPORT_URL" ]; then
    return 0
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "health-report: jq is required but not found — skipping" >&2
    return 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "health-report: curl is required but not found — skipping" >&2
    return 1
  fi

  local payload
  payload="$(_build_health_payload \
    "$agent_id" \
    "$repo" \
    "$run_id" \
    "$outcome" \
    "$duration_secs" \
    "$consecutive_failures" \
    "$exit_code" \
    "$error_msg" \
    "$next_run_at"
  )"

  if ! _validate_health_payload "$payload"; then
    return 1
  fi

  _send_health_report "$HEALTH_REPORT_URL" "$payload" "$token"
}
