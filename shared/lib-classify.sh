#!/usr/bin/env bash
# lib-classify.sh — worker-run failure classification from log files.
#
# Provides a single authoritative pattern table for classifying startup and
# credential failures emitted by worker containers. The host controller
# (controller/main.sh) reads worker stderr or container log output — whether
# from the bash entrypoint or the Python plugin engine's provider subprocess
# — and uses this table to produce a safe, pre-defined one-line message.
#
# No cross-lib dependencies — sources only standard POSIX utilities.
# Source this file in any script that needs failure classification.

# lib-classify.sh is a sourced library; avoid "return" errors when run directly.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  echo "scripts/lib-classify.sh is a library and should be sourced, not executed." >&2
  exit 0
fi

if [ -n "${HIVEMOOT_LIB_CLASSIFY_LOADED:-}" ]; then
  return 0
fi
HIVEMOOT_LIB_CLASSIFY_LOADED=1

# Classify a task failure from a file containing run-once.sh error output.
#
# Scans for known static error patterns emitted by run-once.sh to stderr and
# prints a safe, pre-defined one-line message. Prints nothing on no match.
# Never returns raw file content — only pre-classified messages.
#
# Usage:
#   msg="$(classify_run_failure_from_file "$log_file")"
#
# Arguments:
#   $1 — path to a file containing run-once.sh stderr or container log output
#
# Pattern ordering rationale:
#   Kilo-specific patterns (when KILO_PROVIDER=X) are checked before standalone
#   provider key patterns (ANTHROPIC_API_KEY is required, etc.) to avoid
#   misclassifying a Kilo run as a Claude/Codex/Gemini failure. The two pattern
#   sets share key names but differ in the surrounding error text.
classify_run_failure_from_file() {
  local file="$1"

  [ -s "$file" ] || return 0

  # run-once.sh: "ANTHROPIC_API_KEY is required when KILO_PROVIDER=anthropic."
  if grep -qF "when KILO_PROVIDER=anthropic" "$file" 2>/dev/null; then
    printf 'Kilo provider API key (ANTHROPIC_API_KEY) is missing for KILO_PROVIDER=anthropic'
    return 0
  fi
  # run-once.sh: "OPENAI_API_KEY is required when KILO_PROVIDER=openai."
  if grep -qF "when KILO_PROVIDER=openai" "$file" 2>/dev/null; then
    printf 'Kilo provider API key (OPENAI_API_KEY) is missing for KILO_PROVIDER=openai'
    return 0
  fi
  # run-once.sh: "GOOGLE_API_KEY is required when KILO_PROVIDER=google."
  if grep -qF "when KILO_PROVIDER=google" "$file" 2>/dev/null; then
    printf 'Kilo provider API key (GOOGLE_API_KEY / GEMINI_API_KEY) is missing for KILO_PROVIDER=google'
    return 0
  fi
  # run-once.sh: "OPENROUTER_API_KEY is required when KILO_PROVIDER=openrouter."
  if grep -qF "when KILO_PROVIDER=openrouter" "$file" 2>/dev/null; then
    printf 'Kilo provider API key (OPENROUTER_API_KEY) is missing for KILO_PROVIDER=openrouter'
    return 0
  fi
  # run-once.sh: "KILO_PROVIDER is required — set KILO_PROVIDER or KILOCODE_TOKEN."
  if grep -qF "KILO_PROVIDER is required" "$file" 2>/dev/null; then
    printf 'KILO_PROVIDER is required — set KILO_PROVIDER or KILOCODE_TOKEN'
    return 0
  fi
  # GitHub integration: "missing token..."
  if grep -qiE "GitHub integration: missing token|Missing GitHub token" "$file" 2>/dev/null; then
    printf 'GitHub token is missing'
    return 0
  fi
  # GitHub integration: "failed to validate token..."
  if grep -qiE "GitHub integration: failed to validate token|Failed to validate GitHub token" "$file" 2>/dev/null; then
    printf 'GitHub token validation failed — check token scope or installation access'
    return 0
  fi
  # GitHub integration: "token cannot access <repo>..."
  if grep -qiE "GitHub integration: token cannot access|GitHub token cannot access target repository" "$file" 2>/dev/null; then
    printf 'GitHub token cannot access target repository — check token scope or installation access'
    return 0
  fi
  # GitHub integration: "failed to clone <repo>..."
  if grep -qiE "GitHub integration: failed to clone|Failed to clone" "$file" 2>/dev/null; then
    printf 'Failed to clone repository — check token and repo access'
    return 0
  fi
  # run-once.sh: "ANTHROPIC_API_KEY is required" (standalone Claude provider)
  if grep -qF "ANTHROPIC_API_KEY is required" "$file" 2>/dev/null; then
    printf 'Claude provider API key (ANTHROPIC_API_KEY) is missing'
    return 0
  fi
  # run-once.sh: "OPENAI_API_KEY is required" (standalone Codex provider)
  if grep -qF "OPENAI_API_KEY is required" "$file" 2>/dev/null; then
    printf 'Codex provider API key (OPENAI_API_KEY) is missing'
    return 0
  fi
  # run-once.sh: "GOOGLE_API_KEY (or GEMINI_API_KEY) is required" (standalone Gemini)
  if grep -qF "GOOGLE_API_KEY (or GEMINI_API_KEY) is required" "$file" 2>/dev/null; then
    printf 'Gemini provider API key (GOOGLE_API_KEY / GEMINI_API_KEY) is missing'
    return 0
  fi
  # run-once.sh: "subscription credentials not found" or "subscription login not found"
  if grep -qF "subscription credentials not found" "$file" 2>/dev/null || \
     grep -qF "subscription login not found" "$file" 2>/dev/null; then
    printf 'Provider subscription credentials not found — run the matching auth command'
    return 0
  fi
  # GitHub integration: "gh auth setup-git failed." / run-once.sh legacy helper text
  if grep -qiE "GitHub integration: gh auth setup-git failed|Failed to configure git credential helper" "$file" 2>/dev/null; then
    printf 'Failed to configure git credentials'
    return 0
  fi

  return 0
}
