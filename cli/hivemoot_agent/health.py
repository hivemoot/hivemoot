"""Host-side health reporting CLI.

Replaces shared/health-reporter.sh's `send_heartbeat` shell function.
Used by the controller's periodic scheduler
(`controller/triggers/periodic.sh`) to ping the dashboard backend
with liveness signals.

Best-effort: the controller invokes this with `|| true`, so all
operational failures (network error, bad URL, oversize payload)
exit 0 with a stderr log.  argparse usage errors still exit 2 so
the controller doesn't silently no-op on a bad invocation.

Commands:
    hivemoot-agent health heartbeat \\
        --agent AGENT_ID --repo OWNER/REPO \\
        [--token-file PATH] [--next-run-at ISO8601]
        POST {agent_id, repo, outcome: "heartbeat"[, next_run_at]}
        to $HEALTH_REPORT_URL.  No-ops when the env var is unset.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import urllib.error
import urllib.request

# Mirror shared/health-reporter.sh's _HEALTH_PAYLOAD_MAX_BYTES so
# the backend's payload-size contract stays in one place semantically.
MAX_PAYLOAD_BYTES = 10240

# Hardcoded to match the bounded subshell the shell heartbeat used:
#   ( HEALTH_REPORT_MAX_RETRIES=0 HEALTH_REPORT_TIMEOUT_SECS=3 ... )
# A heartbeat must never stall the controller loop, so a slow or down
# backend should fail fast and the next periodic tick will retry.
#
# Note: this is a per-socket-operation timeout, not a wallclock cap
# (urllib uses socket.settimeout under the hood).  A well-behaved
# backend completes in one recv; pathological slow-trickle responses
# could exceed 3s in aggregate, but heartbeat payloads are tiny so
# the practical risk is bounded.
DEFAULT_TIMEOUT_SECS = 3


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse to follow HTTP redirects.

    urllib's default `HTTPRedirectHandler` forwards request headers
    (including `Authorization`) to the redirect target.  An attacker
    or misconfigured backend that returns a 3xx pointing elsewhere
    would harvest the bearer token.  The shell version used `curl`
    without `-L`, so it never followed redirects either — this
    keeps parity and closes the credential-exposure path.
    """

    def http_error_301(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(
            req.full_url, code, f"redirect not followed (would leak Authorization): {msg}",
            headers, fp,
        )

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


# Built once at import time; reused across invocations.  No state.
_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler)


def register_health_commands(
    subparsers: argparse._SubParsersAction,
) -> None:
    """Register the `health` subcommand group on the root parser."""
    hp = subparsers.add_parser(
        "health",
        help="Health reporting (host-side)",
    )
    hsub = hp.add_subparsers(dest="health_command")

    heartbeat = hsub.add_parser(
        "heartbeat",
        help="POST a liveness heartbeat to $HEALTH_REPORT_URL",
    )
    heartbeat.add_argument(
        "--agent", required=True, help="Agent identifier (e.g. forager)",
    )
    heartbeat.add_argument(
        "--repo", required=True,
        help="Current repo in owner/repo format",
    )
    heartbeat.add_argument(
        "--token-file", default="",
        help="Path to bearer-token file (optional)",
    )
    heartbeat.add_argument(
        "--next-run-at", default="",
        help="ISO 8601 timestamp of agent's next scheduled run (optional)",
    )
    heartbeat.set_defaults(func=cmd_heartbeat)


def _resolve_token(token_file: str) -> str:
    """Resolve bearer token from explicit arg, env file, or env raw.

    Order tried, returning the first that yields a non-empty value:
      1. ``--token-file PATH`` (read file, return its contents)
      2. ``$HIVEMOOT_AGENT_TOKEN_FILE`` env var (treat as path, read file)
      3. ``$HIVEMOOT_AGENT_TOKEN`` env var (raw token string)

    A missing or unreadable file is **skipped silently** — control
    falls through to the next source.  Only when all sources fail
    does this return an empty string (no auth).

    Note: the deleted shell ``send_heartbeat`` had a different
    semantics for the missing-file case — it would send the
    filesystem path itself as the bearer token (e.g.
    ``Authorization: Bearer /run/secrets/missing``).  That was a
    bug; this implementation deliberately diverges by falling
    through to the env-var raw token instead.
    """
    candidate_files = [token_file, os.environ.get("HIVEMOOT_AGENT_TOKEN_FILE", "")]
    for path in candidate_files:
        if not path:
            continue
        try:
            with open(path) as f:
                return f.read().strip()
        except OSError:
            # File missing, permission denied, etc. — try next source.
            continue

    return os.environ.get("HIVEMOOT_AGENT_TOKEN", "").strip()


def _build_payload(agent: str, repo: str, next_run_at: str) -> dict:
    """Build the heartbeat payload.

    Schema matches shared/health-reporter.sh's send_heartbeat exactly:
    no run_id, no duration_secs, no consecutive_failures — heartbeats
    carry no run history and must not touch failure-count state on
    the backend.
    """
    payload: dict = {
        "agent_id": agent,
        "repo": repo,
        "outcome": "heartbeat",
    }
    if next_run_at:
        payload["next_run_at"] = next_run_at
    return payload


def cmd_heartbeat(args: argparse.Namespace) -> int:
    url = os.environ.get("HEALTH_REPORT_URL", "")
    if not url:
        # Reporting disabled — silent no-op, same as the shell.
        return 0

    if not (url.startswith("http://") or url.startswith("https://")):
        print(
            f"health: HEALTH_REPORT_URL must begin with http:// or "
            f"https://, got: {url}",
            file=sys.stderr,
        )
        return 0

    payload = _build_payload(args.agent, args.repo, args.next_run_at)
    body = json.dumps(payload).encode()

    if len(body) > MAX_PAYLOAD_BYTES:
        print(
            f"health: heartbeat payload too large ({len(body)} bytes) "
            f"— skipping",
            file=sys.stderr,
        )
        return 0

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    token = _resolve_token(args.token_file)
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    try:
        with _NO_REDIRECT_OPENER.open(
            req, timeout=DEFAULT_TIMEOUT_SECS,
        ) as resp:
            if resp.status == 200:
                print(
                    f"health: heartbeat sent ({args.agent})",
                    file=sys.stderr,
                )
                return 0
            # urllib raises HTTPError for non-2xx, so this branch
            # only fires for 2xx-non-200 (e.g. 201, 204).  Logged
            # for visibility in case the backend contract drifts.
            print(
                f"health: unexpected response ({resp.status}) "
                f"for {args.agent}",
                file=sys.stderr,
            )
            return 0
    except urllib.error.HTTPError as exc:
        # Surface backend rejections in the controller log so the
        # operator sees actionable codes (401 → check token, 413 →
        # payload too large, 429 → rate limited, 5xx → backend issue).
        print(
            f"health: heartbeat HTTP {exc.code} for {args.agent}",
            file=sys.stderr,
        )
        return 0
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
        # Network errors, DNS failures, timeouts, refused connections.
        # Best-effort: the next periodic tick will retry.  Log the
        # exception class name only (not str(exc)) so a misconfigured
        # URL embedding secrets doesn't leak via the log line.
        print(
            f"health: heartbeat failed for {args.agent}: {type(exc).__name__}",
            file=sys.stderr,
        )
        return 0
