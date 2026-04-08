#!/usr/bin/env bash
# shellcheck disable=SC2154  # globals are supplied by controller/main.sh

[ -n "${HIVEMOOT_CONTROLLER_CORE_QUEUE_LOADED:-}" ] && return 0
HIVEMOOT_CONTROLLER_CORE_QUEUE_LOADED=1

processing_file_is_active() {
  local processing_file="$1"
  local pid=""

  for pid in "${running_pids[@]}"; do
    if [ "${pid_to_processing_file[$pid]:-}" = "$processing_file" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  done

  return 1
}

recover_orphaned_triggers() {
  local now=0
  local mtime=0
  local age_secs=0
  local processing_file=""
  local recovered_file=""
  local max_age_secs=0
  local -a processing_files=()

  now="$(date +%s)"
  max_age_secs=$((agent_timeout_seconds + orphan_recovery_grace_secs))

  shopt -s nullglob
  processing_files=("${queue_root}"/*.processing)
  shopt -u nullglob

  for processing_file in "${processing_files[@]}"; do
    [ -f "$processing_file" ] || continue
    if processing_file_is_active "$processing_file"; then
      continue
    fi
    mtime="$(file_mtime_epoch "$processing_file" "$now")"
    age_secs=$((now - mtime))
    if [ "$age_secs" -le "$max_age_secs" ]; then
      continue
    fi

    recovered_file="${processing_file%.processing}.trigger.json"
    if mv "$processing_file" "$recovered_file" 2>/dev/null; then
      log "Recovered orphaned trigger: $(basename "$processing_file")"
    fi
  done
}

prune_queue_artifacts() {
  local now=0
  local mtime=0
  local age_secs=0
  local artifact_file=""
  local -a artifact_files=()

  if [ "$queue_artifact_ttl_secs" -le 0 ]; then
    return 0
  fi

  now="$(date +%s)"

  shopt -s nullglob
  artifact_files=("${queue_root}"/*.done "${queue_root}"/*.failed)
  shopt -u nullglob

  for artifact_file in "${artifact_files[@]}"; do
    [ -f "$artifact_file" ] || continue
    mtime="$(file_mtime_epoch "$artifact_file" "$now")"
    age_secs=$((now - mtime))
    if [ "$age_secs" -le "$queue_artifact_ttl_secs" ]; then
      continue
    fi
    rm -f "$artifact_file" 2>/dev/null || true
  done
}

prune_stale_workspaces() {
  local now=0
  local mtime=0
  local age_secs=0
  local job_dir=""
  local job_id=""
  local status_file=""
  local status=""
  local pruned=0
  local failed=0
  local prune_failed=0
  local target=""
  local -a workspace_dirs=()
  local -a stale_job_ids=()
  local -a prune_targets=()

  if [ "$workspace_ttl_secs" -le 0 ]; then
    return 0
  fi

  now="$(date +%s)"
  shopt -s nullglob
  workspace_dirs=("${workspaces_root}"/*/)
  shopt -u nullglob

  for job_dir in "${workspace_dirs[@]}"; do
    [ -d "$job_dir" ] || continue
    job_id="$(basename "$job_dir")"
    status_file="${job_dir}/.hivemoot/status"
    if [ ! -f "$status_file" ]; then
      continue
    fi
    status="$(cat "$status_file" 2>/dev/null || true)"
    case "$status" in
      completed|failed|cancelled) ;;
      *) continue ;;
    esac

    mtime="$(file_mtime_epoch "$status_file" "$now")"
    age_secs=$((now - mtime))
    if [ "$age_secs" -le "$workspace_ttl_secs" ]; then
      continue
    fi

    stale_job_ids+=("$job_id")
  done

  for job_id in "${stale_job_ids[@]}"; do
    prune_targets=(
      "${homes_root:?}/${job_id}"
      "${runs_root:?}/${job_id}"
      "${jobs_root:?}/${job_id}"
      "${workspaces_root:?}/${job_id}"
    )
    prune_failed=0

    for target in "${prune_targets[@]}"; do
      if ! rm -rf -- "$target"; then
        log "WARN: failed to remove stale workspace path: job_id=${job_id} path=${target}"
        prune_failed=1
      fi
    done

    for target in "${prune_targets[@]}"; do
      if [ -e "$target" ]; then
        log "WARN: stale workspace prune incomplete: job_id=${job_id} path=${target}"
        prune_failed=1
      fi
    done

    if [ "$prune_failed" -eq 0 ]; then
      pruned=$((pruned + 1))
    else
      failed=$((failed + 1))
    fi
  done

  if [ "$pruned" -gt 0 ]; then
    log "Pruned ${pruned} stale workspace(s) (ttl=${workspace_ttl_secs}s)"
  fi
  if [ "$failed" -gt 0 ]; then
    log "WARN: failed to fully prune ${failed} stale workspace(s) (ttl=${workspace_ttl_secs}s)"
  fi
}

run_queue_maintenance() {
  local force_run="${1:-0}"
  local now=0

  if [ "$force_run" -ne 1 ] && [ "$queue_maintenance_interval_secs" -gt 0 ] && [ "$last_queue_maintenance_epoch" -gt 0 ]; then
    now="$(date +%s)"
    if [ $((now - last_queue_maintenance_epoch)) -lt "$queue_maintenance_interval_secs" ]; then
      return 0
    fi
  fi

  recover_orphaned_triggers
  prune_queue_artifacts
  prune_stale_workspaces
  last_queue_maintenance_epoch="$(date +%s)"
}

process_queue() {
  local -a trigger_files=()
  local trigger_file=""
  local processing_file=""
  local failed_file=""
  local trigger_type=""
  local repo=""
  local agent_id=""
  local extra_prompt=""
  local ack_key=""
  local state_file=""
  local session_key=""
  local job_id=""

  if [ "$shutdown_requested" -ne 0 ]; then
    return 0
  fi

  shopt -s nullglob
  trigger_files=("${queue_root}"/*.trigger.json)
  shopt -u nullglob

  for trigger_file in "${trigger_files[@]}"; do
    if [ "$shutdown_requested" -ne 0 ]; then
      break
    fi

    processing_file="${trigger_file%.trigger.json}.processing"
    failed_file="${trigger_file%.trigger.json}.failed"

    if ! mv "$trigger_file" "$processing_file" 2>/dev/null; then
      continue
    fi

    if ! trigger_type="$(jq -r '.trigger_type // empty' "$processing_file" 2>/dev/null)"; then
      log "Dropping malformed trigger file: ${processing_file}"
      mv -f "$processing_file" "$failed_file"
      continue
    fi
    trigger_type="$(normalize_trigger_name "$trigger_type")"

    if ! repo="$(jq -r '.repo // empty' "$processing_file" 2>/dev/null)" \
      || ! agent_id="$(jq -r '.agent_id // empty' "$processing_file" 2>/dev/null)" \
      || ! extra_prompt="$(jq -r '.extra_prompt // empty' "$processing_file" 2>/dev/null)" \
      || ! ack_key="$(jq -r '.ack_key // empty' "$processing_file" 2>/dev/null)" \
      || ! state_file="$(jq -r '.state_file // empty' "$processing_file" 2>/dev/null)" \
      || ! session_key="$(jq -r '.session_key // empty' "$processing_file" 2>/dev/null)"; then
      log "Dropping malformed trigger file: ${processing_file}"
      mv -f "$processing_file" "$failed_file"
      continue
    fi

    if [ -z "$trigger_type" ] || [ -z "$repo" ] || [ -z "$agent_id" ]; then
      log "Dropping invalid trigger (missing required fields): ${processing_file}"
      mv -f "$processing_file" "$failed_file"
      continue
    fi

    if ! controller_trigger_is_registered "$trigger_type"; then
      log "Dropping unsupported trigger type (${trigger_type}): ${processing_file}"
      mv -f "$processing_file" "$failed_file"
      continue
    fi

    if [ "$repo" != "$target_repo" ]; then
      log "Dropping trigger for unexpected repo (${repo}): ${processing_file}"
      mv -f "$processing_file" "$failed_file"
      continue
    fi

    if [ -z "${agent_token_files[$agent_id]:-}" ]; then
      log "Dropping trigger for unknown agent (${agent_id}): ${processing_file}"
      mv -f "$processing_file" "$failed_file"
      continue
    fi

    if ! controller_invoke_trigger_hook validate_queue_payload "$trigger_type" "$processing_file" "$repo" "$agent_id" "$ack_key" "$state_file" "$session_key"; then
      mv -f "$processing_file" "$failed_file"
      continue
    fi

    job_id="$(generate_job_id)"
    if launch_job "$job_id" "$repo" "$agent_id" "$trigger_type" "$extra_prompt" "$ack_key" "$state_file" "$session_key" "$processing_file"; then
      :
    else
      mv -f "$processing_file" "$failed_file"
    fi
  done
}
