#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains() {
  local path="$1"
  local expected="$2"
  if ! grep -Fqx "$expected" "$path"; then
    echo "Expected file to contain exact line:" >&2
    echo "  $expected" >&2
    echo "Actual file:" >&2
    sed 's/^/  /' "$path" >&2
    fail "missing expected line in ${path}"
  fi
}

assert_file_contains_text() {
  local path="$1"
  local expected="$2"
  if ! grep -Fq "$expected" "$path"; then
    echo "Expected file to contain text:" >&2
    echo "  $expected" >&2
    echo "Actual file:" >&2
    sed 's/^/  /' "$path" >&2
    fail "missing expected text in ${path}"
  fi
}

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p "$tmp_dir/bin" "$tmp_dir/home"
cat > "$tmp_dir/bin/hivemoot-agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "${PLUGIN_ARGS_FILE:?}"
{
  printf 'GITHUB_TOKEN=%s\n' "${GITHUB_TOKEN:-}"
  printf 'GITHUB_TOKEN_FILE=%s\n' "${GITHUB_TOKEN_FILE:-}"
  printf 'AGENT_PLUGINS=%s\n' "${AGENT_PLUGINS:-}"
  printf 'GITHUB_REPOS=%s\n' "${GITHUB_REPOS:-}"
  printf 'TARGET_REPO=%s\n' "${TARGET_REPO:-}"
} > "${PLUGIN_ENV_FILE:?}"
EOF
chmod +x "$tmp_dir/bin/hivemoot-agent"

run_plugin_entrypoint() {
  local args_file="$1"
  local env_file="$2"
  shift 2

  env \
    PATH="${tmp_dir}/bin:${PATH}" \
    HOME="${tmp_dir}/home" \
    PLUGIN_ARGS_FILE="$args_file" \
    PLUGIN_ENV_FILE="$env_file" \
    "$@" \
    bash scripts/entrypoint.sh
}

echo "Running plugin engine routing checks"

args_file="$tmp_dir/once.args"
env_file="$tmp_dir/once.env"
run_plugin_entrypoint \
  "$args_file" \
  "$env_file" \
  AGENT_PLUGINS=github \
  AGENT_DRIVER=once \
  AGENT_WORKLOAD=nonexistent \
  AGENT_TOKEN=ghp_inline

assert_file_contains "$args_file" "oneshot"
assert_file_contains "$env_file" "GITHUB_TOKEN=ghp_inline"
assert_file_contains "$env_file" "GITHUB_TOKEN_FILE="

token_file="$tmp_dir/token.txt"
printf 'ghp_file' > "$token_file"
args_file="$tmp_dir/loop.args"
env_file="$tmp_dir/loop.env"
stderr_file="$tmp_dir/loop.err"
if run_plugin_entrypoint \
  "$args_file" \
  "$env_file" \
  AGENT_PLUGINS=github \
  AGENT_DRIVER=loop \
  AGENT_WORKLOAD=nonexistent \
  AGENT_TOKEN_FILE="$token_file" \
  > /dev/null 2> "$stderr_file"; then
  fail "plugin loop mode succeeded unexpectedly"
fi
assert_file_contains \
  "$stderr_file" \
  "Plugin mode does not support AGENT_DRIVER=loop. Use AGENT_DRIVER=once or controller/main.sh."

args_file="$tmp_dir/explicit.args"
env_file="$tmp_dir/explicit.env"
run_plugin_entrypoint \
  "$args_file" \
  "$env_file" \
  AGENT_PLUGINS=github \
  AGENT_DRIVER=once \
  AGENT_WORKLOAD=nonexistent \
  GITHUB_TOKEN=ghp_explicit \
  AGENT_TOKEN=ghp_fallback

assert_file_contains "$args_file" "oneshot"
assert_file_contains "$env_file" "GITHUB_TOKEN=ghp_explicit"

args_file="$tmp_dir/default-plugin.args"
env_file="$tmp_dir/default-plugin.env"
run_plugin_entrypoint \
  "$args_file" \
  "$env_file" \
  AGENT_PLUGINS=github,hivemoot-github \
  AGENT_DRIVER=once \
  TARGET_REPO=owner/repo \
  AGENT_TOKEN=ghp_alias

assert_file_contains "$args_file" "oneshot"
assert_file_contains "$env_file" "GITHUB_TOKEN=ghp_alias"
assert_file_contains "$env_file" "GITHUB_TOKEN_FILE="
assert_file_contains "$env_file" "AGENT_PLUGINS=github,hivemoot-github"
assert_file_contains "$env_file" "GITHUB_REPOS=owner/repo"
assert_file_contains "$env_file" "TARGET_REPO=owner/repo"

compose_file="$tmp_dir/compose.out"
env \
  AGENT_PLUGINS= \
  AGENT_WORKLOAD=hivemoot-task \
  HIVEMOOT_BUZZ_ROLE=reviewer \
  docker compose config > "$compose_file"

assert_file_contains_text "$compose_file" 'AGENT_PLUGINS: ""'
assert_file_contains_text "$compose_file" "AGENT_WORKLOAD: hivemoot-task"
assert_file_contains_text "$compose_file" "HIVEMOOT_BUZZ_ROLE: reviewer"

echo "PASS: plugin engine routing checks"
