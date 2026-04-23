"""Wrapper for ``hivemoot ack <key> --state-file <path>``.

The Go ``hivemoot`` binary owns GitHub Notifications API ack semantics
(updating the state file's last-seen timestamp so the next watch poll
won't re-emit the event).  The Python plugin shells out to it instead
of re-implementing notification ack in Python — keeps the Go binary
authoritative.

Failure here means: the next ``hivemoot watch`` poll will re-emit the
same event, and the trigger will dispatch it again.  That's the
intended retry behavior; the alternative (skipping ack on transient
GitHub errors) would silently drop notifications.
"""

from __future__ import annotations

import os
import subprocess
import sys


_ACK_TIMEOUT_SECS = 30


def ack_event(ack_key: str, state_file: str, gh_token: str) -> bool:
    """Run ``hivemoot ack`` for one event.  Returns True on success.

    Empty ``ack_key`` or ``state_file`` is a no-op success — there's
    nothing to ack (e.g. the source event lacked a thread id).
    """
    if not ack_key or not state_file:
        return True
    if not gh_token:
        print(
            "[github-watch] ack skipped: no GH_TOKEN available",
            file=sys.stderr, flush=True,
        )
        return False

    env = {**os.environ, "GH_TOKEN": gh_token}
    try:
        result = subprocess.run(
            ["hivemoot", "ack", ack_key, "--state-file", state_file],
            capture_output=True,
            text=True,
            timeout=_ACK_TIMEOUT_SECS,
            env=env,
        )
    except FileNotFoundError:
        print(
            "[github-watch] ack failed: hivemoot binary not found",
            file=sys.stderr, flush=True,
        )
        return False
    except subprocess.TimeoutExpired:
        print(
            f"[github-watch] ack timed out after {_ACK_TIMEOUT_SECS}s "
            f"(key={ack_key})",
            file=sys.stderr, flush=True,
        )
        return False

    if result.returncode == 0:
        return True

    detail = (result.stderr or result.stdout).strip() or "no detail"
    print(
        f"[github-watch] ack failed (key={ack_key}): {detail}",
        file=sys.stderr, flush=True,
    )
    return False
