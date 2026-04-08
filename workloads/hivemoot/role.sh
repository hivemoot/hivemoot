#!/usr/bin/env bash
# Hivemoot workload role resolution via the hivemoot CLI.
#
# resolve_role_prompt_block() fetches role config from the hivemoot CLI
# and formats it into a prompt block for the agent's system instructions.

[ -n "${HIVEMOOT_WORKLOAD_ROLE_LOADED:-}" ] && return 0
HIVEMOOT_WORKLOAD_ROLE_LOADED=1

resolve_role_prompt_block() {
  local role_name="$1"
  local repo_full_name="$2"
  local role_json_output=""
  local role_prompt_block=""

  if ! command -v hivemoot >/dev/null 2>&1; then
    echo "HIVEMOOT_BUZZ_ROLE is set but hivemoot CLI is not installed." >&2
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "HIVEMOOT_BUZZ_ROLE is set but node is not installed for JSON parsing." >&2
    return 1
  fi

  log "Resolving role config via hivemoot role for role=${role_name} repo=${repo_full_name}"
  if ! role_json_output="$(hivemoot role "$role_name" --repo "$repo_full_name" --json 2>&1)"; then
    echo "Failed to resolve role config. Provider launch aborted." >&2
    echo "$role_json_output" >&2
    return 1
  fi

  # shellcheck disable=SC2016  # single quotes intentional — JavaScript code, not shell
  if ! role_prompt_block="$(
    ROLE_JSON="$role_json_output" node -e '
const input = process.env.ROLE_JSON ?? "";
let parsed;
try {
  parsed = JSON.parse(input);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Invalid role JSON payload: ${message}`);
  process.exit(1);
}

const role = parsed && typeof parsed === "object" ? parsed.role : undefined;
if (!role || typeof role !== "object") {
  console.error("Invalid role JSON payload: missing role object");
  process.exit(1);
}
if (typeof role.name !== "string" || role.name.length === 0) {
  console.error("Invalid role JSON payload: missing role.name");
  process.exit(1);
}
if (typeof role.description !== "string") {
  console.error("Invalid role JSON payload: missing role.description");
  process.exit(1);
}
if (typeof role.instructions !== "string") {
  console.error("Invalid role JSON payload: missing role.instructions");
  process.exit(1);
}

const onboarding = typeof parsed.onboarding === "string" ? parsed.onboarding.replace(/\s+$/, "") : "";
const instructions = role.instructions.replace(/\s+$/, "");
const parts = [];
if (onboarding) {
  parts.push(`Team onboarding:\n${onboarding}`);
}
parts.push(`Your role on this project is: ${role.name}\nRole description: ${role.description}\nRole instructions: ${instructions}`);
process.stdout.write(parts.join("\n\n"));
')"; then
    echo "Failed to parse role config JSON. Provider launch aborted." >&2
    echo "$role_json_output" >&2
    return 1
  fi

  printf '%s' "$role_prompt_block"
}
