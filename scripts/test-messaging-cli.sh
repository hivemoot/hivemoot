#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TESTS_RUN=0
TESTS_PASSED=0
TEST_TMP=""

setup() {
  TEST_TMP="$(mktemp -d)"
}

teardown() {
  rm -rf "${TEST_TMP}"
}

fail() {
  echo "FAIL: $*" >&2
  teardown
  exit 1
}

pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
  echo "  PASS: $1"
}

run_test() {
  TESTS_RUN=$((TESTS_RUN + 1))
  setup
  "$@"
  teardown
}

test_poll_empty_allowlist_denies_all() {
  REPO_ROOT="${REPO_ROOT}" python3 - <<'PY'
import contextlib
import io
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.environ["REPO_ROOT"], "cli"))

from hivemoot_agent.messaging.commands import cmd_poll


class DummyAdapter:
    def poll(self, token, offset, timeout):
        return [
            {
                "update_id": 1,
                "chat_id": "999",
                "text": "hello",
                "username": "user",
                "session_key": "tg:999",
                "ack_key": "tg-msg:1",
            }
        ]


args = SimpleNamespace(
    platform="telegram",
    token="token",
    token_file="",
    offset_file="",
    timeout=1,
    allowed_chats="",
    once=True,
)
out = io.StringIO()
err = io.StringIO()
with patch("hivemoot_agent.messaging.platforms.load_adapter", return_value=DummyAdapter()):
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = cmd_poll(args)

assert rc == 0, rc
assert out.getvalue().strip() == "", out.getvalue()
denied = json.loads(err.getvalue().strip())
assert denied == {"type": "denied", "chat_id": "999"}, denied
PY
  pass "messaging poll denies all chats when allowlist is empty"
}

test_poll_matching_allowlist_emits_message() {
  REPO_ROOT="${REPO_ROOT}" python3 - <<'PY'
import contextlib
import io
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.environ["REPO_ROOT"], "cli"))

from hivemoot_agent.messaging.commands import cmd_poll


class DummyAdapter:
    def poll(self, token, offset, timeout):
        return [
            {
                "update_id": 1,
                "chat_id": "999",
                "text": "hello",
                "username": "user",
                "session_key": "tg:999",
                "ack_key": "tg-msg:1",
            }
        ]


args = SimpleNamespace(
    platform="telegram",
    token="token",
    token_file="",
    offset_file="",
    timeout=1,
    allowed_chats="123,999",
    once=True,
)
out = io.StringIO()
err = io.StringIO()
with patch("hivemoot_agent.messaging.platforms.load_adapter", return_value=DummyAdapter()):
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = cmd_poll(args)

assert rc == 0, rc
assert err.getvalue().strip() == "", err.getvalue()
message = json.loads(out.getvalue().strip())
assert message["chat_id"] == "999", message
assert message["text"] == "hello", message
PY
  pass "messaging poll emits events for allowed chats"
}

test_telegram_adapter_keeps_env_token_out_of_argv() {
  local fake_bin="${TEST_TMP}/bin"
  local argv_log="${TEST_TMP}/argv.log"
  local env_log="${TEST_TMP}/env.log"
  mkdir -p "${fake_bin}"

  cat > "${fake_bin}/hivemoot-agent" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "${argv_log}"
printf '%s\n' "\${TELEGRAM_BOT_TOKEN:-}" > "${env_log}"
exit 0
EOF
  chmod +x "${fake_bin}/hivemoot-agent"

  (
    export PATH="${fake_bin}:${PATH}"
    export TELEGRAM_BOT_TOKEN="secret-token-123"
    unset TELEGRAM_BOT_TOKEN_FILE
    # shellcheck source=integrations/messaging/platforms/telegram.sh
    . "${REPO_ROOT}/integrations/messaging/platforms/telegram.sh"
    messaging_platform_validate_config >/dev/null
  ) || fail "telegram adapter validation failed"

  local argv env_token
  argv="$(cat "${argv_log}")"
  env_token="$(cat "${env_log}")"

  [ "${argv}" = "messaging validate --platform telegram" ] \
    || fail "unexpected argv for hivemoot-agent: ${argv}"
  [ "${env_token}" = "secret-token-123" ] \
    || fail "expected env token to stay available to subprocess"
  pass "telegram adapter keeps env token out of CLI argv"
}

echo "Running messaging CLI tests"
echo ""

run_test test_poll_empty_allowlist_denies_all
run_test test_poll_matching_allowlist_emits_message
run_test test_telegram_adapter_keeps_env_token_out_of_argv

echo ""
echo "Passed ${TESTS_PASSED}/${TESTS_RUN} tests"
[ "${TESTS_PASSED}" -eq "${TESTS_RUN}" ] || exit 1
