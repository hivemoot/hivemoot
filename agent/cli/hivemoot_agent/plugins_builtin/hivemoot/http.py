"""Shared HTTP client utilities for the hivemoot plugin.

Both the ``health`` and ``tasks`` features POST JSON to hivemoot.dev
endpoints with a bearer Authorization header.  A shared stdlib-urllib
client keeps third-party deps off the dependency graph and enforces
two security invariants uniformly:

  * Redirects are refused — following 30x would forward the bearer
    to the redirect target and leak Authorization.
  * Only http(s) schemes are accepted; a bad config (e.g. ``file://``
    pointing at a credentials dump) raises before the network call.

Timeout defaults are tight by design: a slow or down backend should
fail fast and the next poll / heartbeat tick will retry.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


DEFAULT_TIMEOUT_SECS = 10


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse to follow HTTP redirects so the bearer token is never
    forwarded to a redirect target (would leak Authorization)."""

    def http_error_301(self, req, fp, code, msg, headers):
        raise urllib.error.HTTPError(
            req.full_url, code,
            f"redirect not followed (would leak Authorization): {msg}",
            headers, fp,
        )

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


_OPENER = urllib.request.build_opener(_NoRedirectHandler)


def post_json(
    url: str,
    payload: dict[str, Any],
    bearer: str,
    *,
    extra_headers: dict[str, str] | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> tuple[int, dict | None, bytes]:
    """POST a JSON payload.  Returns ``(status, parsed_body_or_none, raw_body)``.

    Body is parsed as JSON when possible; on parse failure ``None`` is
    returned and the raw bytes are kept so callers can log.

    Raises ``ValueError`` on a non-http(s) URL scheme — never sends
    credentials to ``file://`` / ``ftp://`` / etc.  Transport-level
    errors surface as ``urllib.error.URLError`` (subclasses) except
    HTTP error responses, which are captured and returned as normal
    ``(status, body)`` tuples so callers can inspect the status code.
    """
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError(f"bad URL scheme: {url}")

    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    if extra_headers:
        for key, value in extra_headers.items():
            req.add_header(key, value)

    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = None
            return resp.status, parsed, raw
    except urllib.error.HTTPError as exc:
        raw = b""
        try:
            raw = exc.read()
        except Exception:
            pass
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = None
        return exc.code, parsed, raw


def get_json(
    url: str,
    bearer: str,
    *,
    extra_headers: dict[str, str] | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECS,
) -> tuple[int, dict | None, bytes]:
    """GET a URL with bearer auth, parse the response as JSON.

    Mirrors `post_json` semantics — same redirect refusal, same
    URL-scheme guard, same error → status-tuple shape. Used by
    the war-room watcher plugin's `/api/rooms/watching` poll
    (Phase F).
    """
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError(f"bad URL scheme: {url}")

    req = urllib.request.Request(url, method="GET")
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    if extra_headers:
        for key, value in extra_headers.items():
            req.add_header(key, value)

    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = None
            return resp.status, parsed, raw
    except urllib.error.HTTPError as exc:
        raw = b""
        try:
            raw = exc.read()
        except Exception:
            pass
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = None
        return exc.code, parsed, raw
