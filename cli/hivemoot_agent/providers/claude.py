"""Claude Code provider."""

from __future__ import annotations

import json

name = "claude"
supports_system_prompt_flag = True


def build_cmd(
    prompt: str,
    system_prompt: str,
    model: str,
    mcp_config: str,
    session_id: str,
) -> list[str]:
    if session_id:
        cmd = [
            "claude", "--resume", session_id, "-p",
            "--verbose",
            "--output-format", "stream-json",
            "--dangerously-skip-permissions",
            "--append-system-prompt", system_prompt,
        ]
    else:
        cmd = [
            "claude", "-p",
            "--verbose",
            "--output-format", "stream-json",
            "--dangerously-skip-permissions",
            "--append-system-prompt", system_prompt,
        ]
    if mcp_config:
        cmd += ["--mcp-config", mcp_config]
    if model:
        cmd += ["--model", model]
    cmd += ["--", prompt]
    return cmd


def extract_session_id(output: str) -> str:
    """Claude emits {"type":"system","subtype":"init","session_id":"..."}."""
    for line in output.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "system" and obj.get("subtype") == "init":
            sid = obj.get("session_id", "")
            if sid:
                return sid
    return ""
