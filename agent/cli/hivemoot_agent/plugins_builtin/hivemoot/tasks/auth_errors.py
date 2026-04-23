"""Detect codex auth errors hiding inside a "successful" run.

Codex sometimes exits 0 with no usable output when its auth state
is broken (refresh token reused, token expired, invalid API key).
Without promotion to a failure, the controller would happily report
the empty result back to the user.

This module scans the codex NDJSON stream for ``error`` and
``turn.failed`` events and returns the first auth-class error code
it finds.  The match list mirrors the shell ``detect_codex_auth_error``
function so the production behavior is unchanged.
"""

from __future__ import annotations

import json
import os
import re

# Auth-class error codes codex may emit explicitly.
_AUTH_CODES = frozenset({
    "refresh_token_reused",
    "invalid_api_key",
    "token_expired",
    "auth_error",
})

# Auth-class messages we promote to "auth_error" when no explicit
# code is present.  Match codex's typical wording.
_AUTH_MESSAGE_RE = re.compile(
    r"Unauthorized|Invalid API key|Incorrect API key", re.IGNORECASE,
)


def detect_codex_auth_error(log_path: str) -> str:
    """Return the auth error code, or "" when none detected.

    Inspects each line of the NDJSON log; the first matching event
    wins (mirrors the shell's ``head -1``).  Non-JSON lines are
    skipped silently.
    """
    if not os.path.isfile(log_path):
        return ""

    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            if not isinstance(event, dict):
                continue
            if event.get("type") not in ("error", "turn.failed"):
                continue

            code = _extract_code(event)
            if code:
                return code

    return ""


def _extract_code(event: dict) -> str:
    """Pick a code or message-derived code from an error event.

    Defensive against shapes codex actually emits in the wild:
      * ``error`` may be a dict (``{"code": ..., "message": ...}``),
      * a string (``"unauthorized"``),
      * or absent.
    A misshapen event must never crash the on_job_finished path —
    a missed promotion is acceptable; an unposted final result is not.
    """
    err = event.get("error")
    err_dict = err if isinstance(err, dict) else {}
    err_string = err if isinstance(err, str) else ""

    explicit = event.get("code") or err_dict.get("code")
    if explicit and (
        explicit in _AUTH_CODES or str(explicit).startswith("auth_")
    ):
        return str(explicit)

    message = event.get("message") or err_dict.get("message") or err_string
    if message and _AUTH_MESSAGE_RE.search(str(message)):
        return "auth_error"

    return ""
