#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[run-loop %s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

shutdown_requested=0
multi_pid=""

# shellcheck disable=SC2317,SC2329  # invoked via trap on line below
request_shutdown() {
  if [ "$shutdown_requested" -eq 0 ]; then
    shutdown_requested=1
    log "Shutdown signal received; will exit after current cycle completes"
    if [ -n "$multi_pid" ]; then
      kill -TERM "$multi_pid" 2>/dev/null || true
    fi
  fi
}

trap request_shutdown TERM INT

base_secs="${BASE_SECS:-600}"
jitter_secs="${JITTER_SECS:-150}"
max_failures="${MAX_CONSECUTIVE_FAILURES:-5}"
consecutive_failures=0

case "$base_secs" in
  ''|*[!0-9]*) echo "BASE_SECS must be a positive integer" >&2; exit 1 ;;
esac
case "$jitter_secs" in
  ''|*[!0-9]*) echo "JITTER_SECS must be a non-negative integer" >&2; exit 1 ;;
esac
case "$max_failures" in
  ''|*[!0-9]*) echo "MAX_CONSECUTIVE_FAILURES must be a positive integer" >&2; exit 1 ;;
esac

if [ "$base_secs" -le 0 ]; then
  echo "BASE_SECS must be > 0" >&2; exit 1
fi
if [ "$max_failures" -le 0 ]; then
  echo "MAX_CONSECUTIVE_FAILURES must be > 0" >&2; exit 1
fi

log "Loop mode started (base=${base_secs}s jitter=±${jitter_secs}s)"

while [ "$shutdown_requested" -eq 0 ]; do
  # Background + wait so our TERM trap fires immediately
  /opt/hivemoot-agent/scripts/run-multi.sh &
  multi_pid=$!

  set +e
  wait "$multi_pid"
  multi_exit=$?
  set -e
  multi_pid=""

  if [ "$shutdown_requested" -ne 0 ]; then
    log "Shutdown requested; exiting loop"
    break
  fi

  if [ "$multi_exit" -eq 0 ]; then
    consecutive_failures=0
    log "Run completed successfully"
  else
    consecutive_failures=$((consecutive_failures + 1))
    log "Run failed (exit=${multi_exit}, consecutive_failures=${consecutive_failures})"
    if [ "$consecutive_failures" -ge "$max_failures" ]; then
      log "Reached max consecutive failures threshold (${max_failures}); exiting loop"
      exit "$multi_exit"
    fi
  fi

  # Clamp jitter so distribution stays symmetric around base_secs
  effective_jitter="$jitter_secs"
  if [ "$effective_jitter" -ge "$base_secs" ]; then
    effective_jitter=$((base_secs - 1))
  fi
  min_delay=$((base_secs - effective_jitter))
  max_delay=$((base_secs + effective_jitter))
  span=$((max_delay - min_delay + 1))
  delay=$((min_delay + RANDOM % span))
  log "Sleeping ${delay}s before next run"
  # Interruptible sleep
  sleep "$delay" &
  wait $! || true
done

log "Graceful shutdown complete"
exit 0
