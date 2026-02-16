#!/usr/bin/env bash
# Shared OpenCode helper functions sourced by run-once.sh, run-loop.sh,
# and run-multi.sh. Callers must define a log() function before sourcing.

# Auto-generate OpenCode config and auth.json if missing. Config holds
# permissions and model selection; auth.json holds the actual API key
# (OpenCode reads credentials from auth.json, NOT from provider options).
generate_opencode_config() {
  local target_home="$1"
  local config_dir="${target_home}/.config/opencode"
  local config_file="${config_dir}/opencode.json"
  local auth_dir="${target_home}/.local/share/opencode"
  local auth_file="${auth_dir}/auth.json"

  if [ "${AGENT_PROVIDER:-}" != "opencode" ]; then
    return 0
  fi

  # Generate config (permissions + model) if missing
  if [ ! -f "$config_file" ]; then
    mkdir -p "$config_dir"
    chmod 700 "$config_dir" 2>/dev/null || log "Warning: chmod 700 failed on ${config_dir}"

    if [ ! -f /opt/hivemoot-agent/scripts/opencode-config-template.json ]; then
      log "Warning: OpenCode config template not found; skipping config generation"
      return 0
    fi

    cp /opt/hivemoot-agent/scripts/opencode-config-template.json "$config_file"
    chmod 600 "$config_file" 2>/dev/null || log "Warning: chmod 600 failed on ${config_file}"

    local opencode_provider="${OPENCODE_PROVIDER:-}"
    if [ -n "$opencode_provider" ]; then
      local model_default=""
      local provider_config=""
      case "$opencode_provider" in
        zai)
          model_default="${OPENCODE_MODEL:-zai/glm-5}"
          provider_config='{"zai":{"name":"Z.AI","npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://api.z.ai/api/coding/paas/v4"},"models":{"glm-5":{"id":"glm-5","name":"GLM-5"}}}}'
          ;;
        *)
          model_default="${OPENCODE_MODEL:-}"
          log "Warning: unknown OPENCODE_PROVIDER '${opencode_provider}'; no provider config will be generated"
          ;;
      esac

      # $model/$provider below are jq variables (--arg), not shell — single quotes intentional
      # shellcheck disable=SC2016
      local merge_expr='. + {"model": $model}'
      if [ -n "$provider_config" ]; then
        # shellcheck disable=SC2016
        merge_expr='. + {"model": $model, "provider": $provider}'
      fi

      if [ -n "$model_default" ]; then
        if ! jq --arg model "$model_default" --argjson provider "${provider_config:-null}" \
          "$merge_expr" "$config_file" > "${config_file}.tmp"; then
          log "Warning: jq merge failed; using base config only"
          rm -f "${config_file}.tmp"
        else
          mv "${config_file}.tmp" "$config_file"
          chmod 600 "$config_file" 2>/dev/null || log "Warning: chmod 600 failed on ${config_file}"
        fi
      fi

      log "Generated OpenCode config for provider=${opencode_provider}: ${config_file}"
    else
      log "Warning: OPENCODE_PROVIDER not set; generated base config only"
    fi
  fi

  # Generate auth.json (API key) if missing. OpenCode reads credentials
  # from this file, not from {env:} references in config provider options.
  if [ ! -f "$auth_file" ]; then
    local opencode_provider="${OPENCODE_PROVIDER:-}"
    local api_key=""

    case "$opencode_provider" in
      zai) api_key="${ZAI_API_KEY:-}" ;;
    esac

    if [ -n "$api_key" ] && [ -n "$opencode_provider" ]; then
      mkdir -p "$auth_dir"
      chmod 700 "$auth_dir" 2>/dev/null || log "Warning: chmod 700 failed on ${auth_dir}"
      jq -n --arg provider "$opencode_provider" --arg key "$api_key" \
        '{($provider): {"type": "api", "key": $key}}' > "$auth_file"
      chmod 600 "$auth_file" 2>/dev/null || log "Warning: chmod 600 failed on ${auth_file}"
      log "Generated OpenCode auth.json for provider=${opencode_provider}: ${auth_file}"
    fi
  fi
}
