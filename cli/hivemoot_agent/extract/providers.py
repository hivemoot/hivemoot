"""Provider-specific response extraction from agent run logs.

Each provider emits a different log format. This module handles the
parsing for each one, replacing the fragile jq pipelines in the bash
workload.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Optional


def extract_response(
    provider: str,
    log_file: str,
    sidecar_file: Optional[str] = None,
) -> str:
    """Extract the agent's final response text from a run log.

    Returns the response string, or empty string if extraction fails.
    """
    if not os.path.isfile(log_file):
        return ""

    extractors = {
        "claude": _extract_claude,
        "codex": _extract_codex,
        "gemini": _extract_generic,
        "kilo": _extract_generic,
        "opencode": _extract_generic,
    }

    extractor = extractors.get(provider, _extract_generic)

    if provider == "codex" and sidecar_file:
        text = _read_sidecar(sidecar_file)
        if text:
            return text

    return extractor(log_file)


def _extract_claude(log_file: str) -> str:
    """Claude stream-json: extract .result from the last type=result event."""
    result = ""
    with open(log_file, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "result":
                candidate = obj.get("result", "")
                if candidate:
                    result = candidate
    return result


def _extract_codex(log_file: str) -> str:
    """Codex JSONL: extract .item.text from the last item.completed/agent_message."""
    result = ""
    with open(log_file, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "item.completed":
                item = obj.get("item", {})
                if item.get("type") == "agent_message":
                    text = item.get("text", "")
                    if text:
                        result = text
    return result


def _extract_generic(log_file: str) -> str:
    """Generic extraction for providers without a typed result event.

    Strategy:
    1. Try to find a JSON line with .result, .text, or .content fields.
    2. Fall back to the longest non-JSON, non-empty line in the last 200 lines.
    """
    lines: list[str] = []
    with open(log_file, errors="replace") as f:
        for line in f:
            lines.append(line.rstrip())
            # Keep only the last 500 lines in memory.
            if len(lines) > 500:
                lines = lines[-500:]

    # Pass 1: scan for JSON with text fields (last match wins).
    json_result = ""
    for line in lines:
        stripped = line.strip()
        if not stripped or not stripped.startswith("{"):
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            continue

        for key in ("result", "text", "content", "message"):
            val = obj.get(key)
            if isinstance(val, str) and len(val) > 20:
                json_result = val

    if json_result:
        return json_result

    # Pass 2: longest non-empty, non-JSON line from the tail.
    tail = lines[-200:] if len(lines) > 200 else lines
    best = ""
    for line in tail:
        stripped = line.strip()
        if not stripped or stripped.startswith("{"):
            continue
        if len(stripped) > len(best):
            best = stripped

    return best


def _read_sidecar(path: str) -> str:
    """Read a Codex sidecar answer file if it exists and is non-empty."""
    if not path or not os.path.isfile(path):
        return ""
    try:
        text = open(path, errors="replace").read().strip()
        return text
    except OSError:
        return ""
