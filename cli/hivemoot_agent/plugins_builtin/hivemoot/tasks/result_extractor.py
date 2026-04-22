"""Extract the final markdown result from a provider's NDJSON log.

Each provider streams its run as line-delimited JSON.  This module
locates the final user-facing message in that stream and returns it.

Mirrors the shell extract_*_result_markdown / extract_text_result_from_log
functions previously in controller/triggers/hivemoot-task.sh — the
behavior under each provider is preserved.
"""

from __future__ import annotations

import json
import os
from typing import Iterable


def _iter_json_lines(log_path: str) -> Iterable[dict]:
    """Yield each parseable JSON object on its own line.

    Lines that don't parse as JSON are skipped silently — provider
    streams sometimes interleave plain stderr that isn't part of the
    structured event stream.
    """
    if not os.path.isfile(log_path):
        return
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def extract_codex_result(
    log_path: str, sidecar_path: str = "",
) -> str:
    """Return the final agent message from a codex run.

    Codex writes its final markdown answer to a sidecar file when
    invoked with --output-last-message; that file is the source of
    truth when present.  The NDJSON log is the fallback — we pick
    the last ``item.completed`` event whose item is an
    ``agent_message``.
    """
    if sidecar_path:
        try:
            if os.path.getsize(sidecar_path) > 0:
                with open(sidecar_path) as f:
                    return f.read()
        except OSError:
            pass

    last_text = ""
    for event in _iter_json_lines(log_path):
        if event.get("type") != "item.completed":
            continue
        item = event.get("item") or {}
        if item.get("type") != "agent_message":
            continue
        text = item.get("text") or ""
        if text:
            last_text = text
    return last_text


def extract_claude_result(log_path: str) -> str:
    """Return the final ``result`` string from a claude run.

    Claude's stream-json emits one ``{"type":"result"}`` event with
    the user-facing markdown.  We take the last such event (there
    should only be one, but be defensive).
    """
    last_result = ""
    for event in _iter_json_lines(log_path):
        if event.get("type") == "result":
            value = event.get("result")
            if value:
                last_result = str(value)
    return last_result


def _read_text(log_path: str) -> str:
    """Plain-text fallback for providers without structured output."""
    if not os.path.isfile(log_path):
        return ""
    try:
        if os.path.getsize(log_path) <= 0:
            return ""
        with open(log_path) as f:
            return f.read()
    except OSError:
        return ""


def extract_result(
    provider: str, log_path: str, sidecar_path: str = "",
) -> str:
    """Provider-dispatching wrapper.

    Returns the empty string when extraction fails or the log has
    no extractable content.  Callers decide what to do with empty
    (the controller previously emitted a "no output captured" stub).
    """
    if provider == "codex":
        return extract_codex_result(log_path, sidecar_path=sidecar_path)
    if provider == "claude":
        return extract_claude_result(log_path)
    if provider in ("gemini", "kilo", "opencode"):
        return _read_text(log_path)
    # Unknown provider — try plain text to give the operator something.
    return _read_text(log_path)
