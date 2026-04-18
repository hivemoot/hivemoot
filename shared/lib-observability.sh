#!/usr/bin/env bash
# lib-observability.sh — run-event logging, health snapshots, and agent stats.
#
# Extracted from lib.sh. No cross-lib dependencies — sources only standard
# POSIX utilities (date, jq, mv). Source this file directly in any orchestrator
# that needs these functions; do not let one lib source another.

# lib.sh is a sourced library; avoid "return" errors when run directly.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  echo "shared/lib-observability.sh is a library and should be sourced, not executed." >&2
  exit 0
fi

if [ -n "${HIVEMOOT_LIB_OBSERVABILITY_LOADED:-}" ]; then
  return 0
fi
HIVEMOOT_LIB_OBSERVABILITY_LOADED=1

# Append a structured JSON event to an NDJSON events file.
# Each call emits one JSON object per line (newline-delimited JSON).
# Usage: log_event <events_file> <event_name> <agent_id> <run_id> <event_seq> [extra_fields]
# extra_fields: raw JSON field list (no outer braces), e.g. '"duration_secs":42,"outcome":"success"'
log_event() {
  local events_file="$1"
  local event_name="$2"
  local agent_id="$3"
  local run_id="$4"
  local event_seq="$5"
  local extra="${6:-}"
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [ -n "$extra" ]; then
    printf '{"event":"%s","agent_id":"%s","run_id":"%s","event_seq":%d,"timestamp":"%s",%s}\n' \
      "$event_name" "$agent_id" "$run_id" "$event_seq" "$ts" "$extra" >> "$events_file"
  else
    printf '{"event":"%s","agent_id":"%s","run_id":"%s","event_seq":%d,"timestamp":"%s"}\n' \
      "$event_name" "$agent_id" "$run_id" "$event_seq" "$ts" >> "$events_file"
  fi
}

# Write an agent health snapshot atomically via temp-file + mv.
# Readers never observe a partial write. Overwrites the previous snapshot.
# Usage: write_health_snapshot <health_file> <agent_id> <run_id> <last_event> <consecutive_failures>
write_health_snapshot() {
  local health_file="$1"
  local agent_id="$2"
  local run_id="$3"
  local last_event="$4"
  local consecutive_failures="${5:-0}"
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  local tmp_file="${health_file}.tmp.$$"
  printf '{"agent_id":"%s","run_id":"%s","last_event":"%s","consecutive_failures":%d,"updated_at":"%s"}\n' \
    "$agent_id" "$run_id" "$last_event" "$consecutive_failures" "$ts" > "$tmp_file"
  mv "$tmp_file" "$health_file"
}

# Atomically increment persistent agent run/error counters.
# Uses the same temp+mv pattern as write_health_snapshot.
# Prints "run_count\terror_count" after the increment so callers can
# capture the updated values without a second read.
# Usage: update_agent_stats <stats_file> <is_error>
#   is_error: 1 if the run failed, 0 otherwise
update_agent_stats() {
  local stats_file="$1"
  local is_error="${2:-0}"
  local run_count=0
  local error_count=0
  local ts

  if [ -f "$stats_file" ] && command -v jq >/dev/null 2>&1; then
    run_count="$(jq -r '.run_count // 0' "$stats_file" 2>/dev/null || printf '0')"
    error_count="$(jq -r '.error_count // 0' "$stats_file" 2>/dev/null || printf '0')"
  fi

  run_count=$((run_count + 1))
  if [ "$is_error" -eq 1 ]; then
    error_count=$((error_count + 1))
  fi

  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  local stats_dir
  stats_dir="$(dirname "$stats_file")"
  mkdir -p "$stats_dir"
  local tmp_file="${stats_file}.tmp.$$"
  printf '{"run_count":%d,"error_count":%d,"updated_at":"%s"}\n' \
    "$run_count" "$error_count" "$ts" > "$tmp_file"
  mv "$tmp_file" "$stats_file"

  printf '%d\t%d' "$run_count" "$error_count"
}
