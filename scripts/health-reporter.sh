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
_VALID_STATUSES="active idle error offline"
_VALID_OUTCOMES="success failure skipped"

# Derive the installation identifier from TARGET_REPO owner.
# Override via HIVEMOOT_INSTALLATION env var.
_resolve_installation() {
  local target_repo="$1"
  local override="${HIVEMOOT_INSTALLATION:-}"

  if [ -n "$override" ]; then
    printf '%s' "$override"
    return 0
  fi

  # Extract owner from owner/repo format
  printf '%s' "${target_repo%%/*}"
}

# Build the JSON payload for the health report.
# Requires jq.
_build_health_payload() {
  local agent_id="$1"
  local installation="$2"
  local status="$3"
  local last_run="$4"
  local last_outcome="$5"
  local run_count="$6"
  local error_count="$7"
  local consecutive_failures="$8"
  local duration_secs="$9"
  local current_repos="${10}"

  jq -n \
    --arg agent_id "$agent_id" \
    --arg installation "$installation" \
    --arg status "$status" \
    --arg last_run "$last_run" \
    --arg last_outcome "$last_outcome" \
    --argjson run_count "$run_count" \
    --argjson error_count "$error_count" \
    --argjson consecutive_failures "$consecutive_failures" \
    --argjson duration_secs "$duration_secs" \
    --arg current_repos "$current_repos" \
    '{
      agent_id: $agent_id,
      installation: $installation,
      status: $status,
      last_run: $last_run,
      last_outcome: $last_outcome,
      run_count: $run_count,
      error_count: $error_count,
      consecutive_failures: $consecutive_failures,
      duration_secs: $duration_secs,
      current_repos: ($current_repos | split(",") | map(select(length > 0)))
    }'
}

# Validate the payload before sending.
# Returns 0 on success, 1 on validation failure (with message on stderr).
_validate_health_payload() {
  local payload="$1"

  # Required string fields must be non-empty
  local field
  for field in agent_id installation status last_run last_outcome; do
    local value
    value="$(printf '%s' "$payload" | jq -r ".$field // empty")"
    if [ -z "$value" ]; then
      echo "health-report: validation failed — missing required field: ${field}" >&2
      return 1
    fi
  done

  # Enum: status
  local status_val
  status_val="$(printf '%s' "$payload" | jq -r '.status')"
  local valid=0
  local s
  for s in $_VALID_STATUSES; do
    if [ "$status_val" = "$s" ]; then valid=1; break; fi
  done
  if [ "$valid" -eq 0 ]; then
    echo "health-report: validation failed — invalid status: ${status_val} (expected: ${_VALID_STATUSES})" >&2
    return 1
  fi

  # Enum: last_outcome
  local outcome_val
  outcome_val="$(printf '%s' "$payload" | jq -r '.last_outcome')"
  valid=0
  for s in $_VALID_OUTCOMES; do
    if [ "$outcome_val" = "$s" ]; then valid=1; break; fi
  done
  if [ "$valid" -eq 0 ]; then
    echo "health-report: validation failed — invalid last_outcome: ${outcome_val} (expected: ${_VALID_OUTCOMES})" >&2
    return 1
  fi

  # Non-negative numeric fields
  local num_field
  for num_field in run_count error_count consecutive_failures duration_secs; do
    local num_val
    num_val="$(printf '%s' "$payload" | jq -r ".$num_field")"
    if ! printf '%s' "$num_val" | grep -Eq '^[0-9]+$'; then
      echo "health-report: validation failed — ${num_field} must be a non-negative integer: ${num_val}" >&2
      return 1
    fi
  done

  # current_repos entries must be owner/repo format
  local repo_count
  repo_count="$(printf '%s' "$payload" | jq '.current_repos | length')"
  local i=0
  while [ "$i" -lt "$repo_count" ]; do
    local repo_entry
    repo_entry="$(printf '%s' "$payload" | jq -r ".current_repos[$i]")"
    if ! printf '%s' "$repo_entry" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
      echo "health-report: validation failed — malformed current_repos entry: ${repo_entry}" >&2
      return 1
    fi
    i=$((i + 1))
  done

  # Size budget
  local payload_size
  payload_size="$(printf '%s' "$payload" | wc -c | tr -d ' ')"
  if [ "$payload_size" -gt "$_HEALTH_PAYLOAD_MAX_BYTES" ]; then
    echo "health-report: validation failed — payload too large: ${payload_size} bytes (max ${_HEALTH_PAYLOAD_MAX_BYTES})" >&2
    return 1
  fi

  # Verify no unexpected fields (contract guardrail)
  local expected_fields="agent_id consecutive_failures current_repos duration_secs error_count installation last_outcome last_run run_count status"
  local actual_fields
  actual_fields="$(printf '%s' "$payload" | jq -r 'keys | .[]' | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ "$actual_fields" != "$expected_fields" ]; then
    echo "health-report: validation failed — unexpected fields in payload (expected: ${expected_fields}, got: ${actual_fields})" >&2
    return 1
  fi

  return 0
}

# Send health report with retry logic for 5xx/network errors.
# Args: url, payload, token_file
_send_health_report() {
  local url="$1"
  local payload="$2"
  local token_file="$3"
  local max_retries="${HEALTH_REPORT_MAX_RETRIES}"
  local timeout="${HEALTH_REPORT_TIMEOUT_SECS}"
  local attempt=0
  local backoff=1

  while [ "$attempt" -le "$max_retries" ]; do
    local http_code=""
    local curl_exit=0

    local curl_args=(-s -o /dev/null -w '%{http_code}' --max-time "$timeout")
    curl_args+=(-X POST -H 'Content-Type: application/json')

    # Auth header — token read from file, same pattern as codebase (run-loop.sh)
    if [ -n "$token_file" ] && [ -f "$token_file" ]; then
      curl_args+=(-H "Authorization: Bearer $(cat "$token_file")")
    fi

    curl_args+=(-d "$payload" "$url")

    http_code="$(curl "${curl_args[@]}")" || curl_exit=$?

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
#   agent_id        — agent identifier (e.g. "forager")
#   target_repo     — current repo in owner/repo format
#   token_file      — path to GitHub token file (may be empty)
#   run_outcome     — "success" | "failure" | "skipped"
#   duration_secs   — run duration in seconds
#   consecutive_failures — current streak of consecutive failures
#   stats_file      — path to agent-stats.json
report_health_to_backend() {
  local agent_id="$1"
  local target_repo="$2"
  local token_file="${3:-}"
  local run_outcome="$4"
  local duration_secs="$5"
  local consecutive_failures="${6:-0}"
  local stats_file="$7"

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

  local installation
  installation="$(_resolve_installation "$target_repo")"

  local last_run
  last_run="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # Determine status from outcome and failure streak
  local status="active"
  if [ "$consecutive_failures" -gt 0 ] && [ "$run_outcome" != "success" ]; then
    status="error"
  fi

  # Read current stats
  local run_count=0
  local error_count=0
  if [ -f "$stats_file" ]; then
    run_count="$(jq -r '.run_count // 0' "$stats_file" 2>/dev/null || printf '0')"
    error_count="$(jq -r '.error_count // 0' "$stats_file" 2>/dev/null || printf '0')"
  fi

  local payload
  payload="$(_build_health_payload \
    "$agent_id" \
    "$installation" \
    "$status" \
    "$last_run" \
    "$run_outcome" \
    "$run_count" \
    "$error_count" \
    "$consecutive_failures" \
    "$duration_secs" \
    "$target_repo"
  )"

  if ! _validate_health_payload "$payload"; then
    return 1
  fi

  _send_health_report "$HEALTH_REPORT_URL" "$payload" "$token_file"
}
