"""Shared bearer-token resolution for the hivemoot plugin.

Both the ``health`` and ``tasks`` features authenticate against the
hivemoot.dev backend using the same installation-scoped bearer
token.  Resolution order (first match wins):

  1. Explicit ``token_file`` argument (typed config path).
  2. ``HIVEMOOT_AGENT_TOKEN_FILE`` env var.
  3. ``HIVEMOOT_AGENT_TOKEN`` env var (raw, no file indirection).

Missing / unreadable files fall through silently — the caller
decides whether no-auth is fatal (for writes it is; validate()
fails closed).
"""

from __future__ import annotations

import os
import sys


# Upper bound for the token file.  Installation tokens are 64-char
# hex per the AGENT_HEALTH_CONTRACT; 4KB leaves enormous headroom
# for future token formats while making an accidental misconfig
# (env var pointing at a log file / /etc/passwd / a keyring dump)
# fail fast instead of silently shipping the file's contents as a
# Bearer header.  The attacker model here is mostly
# operator-fat-finger — process-controlling attackers already own
# the token — so the goal is "fail loudly on nonsense," not
# "defense in depth".
_MAX_TOKEN_FILE_BYTES = 4096


def resolve_agent_token(config_token_file: str = "") -> str:
    """Return the bearer token or empty string.

    Mutual exclusion: when both ``HIVEMOOT_AGENT_TOKEN_FILE`` and
    ``HIVEMOOT_AGENT_TOKEN`` env vars are set, the file wins but a
    warning is logged so the operator notices the misconfiguration
    rather than silently shipping a stale token.

    Oversize guard: token files larger than ``_MAX_TOKEN_FILE_BYTES``
    are refused with a stderr log so a misconfigured path (pointing
    at a log file or a binary) never gets shipped as a Bearer header.
    """
    env_file = os.environ.get("HIVEMOOT_AGENT_TOKEN_FILE", "")
    env_raw = os.environ.get("HIVEMOOT_AGENT_TOKEN", "")
    if env_file and env_raw:
        print(
            "[hivemoot] both HIVEMOOT_AGENT_TOKEN_FILE and "
            "HIVEMOOT_AGENT_TOKEN are set; using the file. Unset one "
            "to silence this warning.",
            file=sys.stderr, flush=True,
        )

    for path in (config_token_file, env_file):
        if not path:
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        if st.st_size > _MAX_TOKEN_FILE_BYTES:
            print(
                f"[hivemoot] token file {path!r} is "
                f"{st.st_size} bytes (limit "
                f"{_MAX_TOKEN_FILE_BYTES}); refusing to read. "
                "Check HIVEMOOT_AGENT_TOKEN_FILE is pointing at the "
                "right path.",
                file=sys.stderr, flush=True,
            )
            continue
        try:
            with open(path) as f:
                return f.read().strip()
        except OSError:
            continue

    return env_raw.strip()
