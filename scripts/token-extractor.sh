#!/usr/bin/env bash
# token-extractor.sh — sourced library for extracting per-provider token usage
# from NDJSON agent logs.
# Best-effort: each function returns empty string on failure.

if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  echo "scripts/token-extractor.sh is a library and should be sourced, not executed." >&2
  exit 0
fi

if [ -n "${HIVEMOOT_TOKEN_EXTRACTOR_LOADED:-}" ]; then
  return 0
fi
HIVEMOOT_TOKEN_EXTRACTOR_LOADED=1

# Extract token usage from a Claude NDJSON stream log.
# Uses the final "type":"result" event.
# Sums tokens from .modelUsage (captures all models, including subagent models).
# Top-level fields: input_tokens, output_tokens, cache_read_input_tokens,
#   cache_creation_input_tokens, cost_usd, num_turns, model_breakdown.
# Outputs a compact JSON object or empty string on failure/unavailable.
extract_claude_token_usage_from_log() {
  local path="$1"
  if [ ! -f "$path" ] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi
  # Claude modelUsage uses camelCase keys (inputTokens, outputTokens, etc.)
  jq -Rrs '
    [split("\n")[] | select(length > 0) | try fromjson catch null | select(. != null)]
    | map(select(.type == "result")) | last
    | if . == null then empty
      else
        (.modelUsage // {}) as $mu |
        {
          input_tokens:                ([$mu | to_entries[].value | (.inputTokens // .input_tokens // 0)] | add // null),
          output_tokens:               ([$mu | to_entries[].value | (.outputTokens // .output_tokens // 0)] | add // null),
          cache_read_input_tokens:     ([$mu | to_entries[].value | (.cacheReadInputTokens // .cache_read_input_tokens // 0)] | add // null),
          cache_creation_input_tokens: ([$mu | to_entries[].value | (.cacheCreationInputTokens // .cache_creation_input_tokens // 0)] | add // null),
          cost_usd:  (.total_cost_usd // null),
          num_turns: (.num_turns // null),
          model_breakdown: (
            if ($mu | keys | length) > 0 then
              $mu | with_entries(.value = (
                .value | {
                  input_tokens:                (.inputTokens // .input_tokens),
                  output_tokens:               (.outputTokens // .output_tokens),
                  cache_read_input_tokens:     (.cacheReadInputTokens // .cache_read_input_tokens),
                  cache_creation_input_tokens: (.cacheCreationInputTokens // .cache_creation_input_tokens),
                  cost_usd:                    (.costUSD // .cost_usd)
                } | with_entries(select(.value != null))
              ))
            else null end
          )
        }
        | with_entries(select(.value != null))
      end
  ' "$path" 2>/dev/null || true
}

# Extract token usage from a Codex NDJSON stream log.
# Sums usage across all "type":"turn.completed" events (no final summary exists).
# Codex reports: input_tokens, output_tokens, cached_input_tokens (→ cache_read_input_tokens).
# Outputs a compact JSON object or empty string on failure/unavailable.
extract_codex_token_usage_from_log() {
  local path="$1"
  if [ ! -f "$path" ] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi
  jq -Rrs '
    [split("\n")[] | select(length > 0) | try fromjson catch null | select(. != null)]
    | map(select(.type == "turn.completed"))
    | if length == 0 then empty
      else
        {
          input_tokens:                ([.[].usage.input_tokens          // 0] | add),
          output_tokens:               ([.[].usage.output_tokens         // 0] | add),
          cache_read_input_tokens:     ([.[].usage.cached_input_tokens   // 0] | add),
          cache_creation_input_tokens: null,
          cost_usd:                    null,
          num_turns:                   length
        }
      end
  ' "$path" 2>/dev/null || true
}

# Extract a run summary string from the provider's NDJSON log.
# Best-effort: returns empty string on failure, missing file, or unsupported provider.
# Output is capped at max_bytes (default 1500) to stay within health payload budget.
#
# Claude:  reads .result from the final type=="result" stream-JSON event.
# Codex:   reads .text from the last item.completed agent_message event.
# Others:  returns empty (skip).
extract_run_summary_from_log() {
  local provider="$1"
  local path="$2"
  local max_bytes="${3:-1500}"

  if [ ! -f "$path" ] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi

  local raw=""
  case "$provider" in
    claude)
      raw="$(jq -Rrs '
        [split("\n")[] | select(length > 0) | try fromjson catch null | select(. != null)]
        | map(select(.type == "result")) | last
        | if . == null then empty else (.result // empty) end
      ' "$path" 2>/dev/null)" || true
      ;;
    codex)
      local encoded
      encoded="$(jq -Rr '
        fromjson?
        | select(.type=="item.completed")
        | .item
        | select(.type=="agent_message")
        | .text // empty
        | @base64
      ' "$path" 2>/dev/null | tail -n 1)" || true
      if [ -n "$encoded" ]; then
        raw="$(printf '%s\n' "$encoded" | jq -Rr '@base64d' 2>/dev/null)" || true
      fi
      ;;
    *)
      return 0
      ;;
  esac

  if [ -n "$raw" ]; then
    printf '%s' "$raw" | head -c "$max_bytes"
  fi
}
