"""Codex (OpenAI) provider."""

from __future__ import annotations

import json

name = "codex"
supports_system_prompt_flag = False


def build_cmd(
    prompt: str,
    system_prompt: str,
    model: str,
    mcp_config: str,
    session_id: str,
) -> list[str]:
    # --json is required for JSONL output so we can extract thread_id
    # for session persistence and item.completed for responses.
    common = ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--json"]
    combined = f"{system_prompt}\n\n{prompt}"
    if session_id:
        cmd = ["codex", "exec", "resume"] + common
        if model:
            cmd += ["--model", model]
        cmd += [session_id, combined]
    else:
        cmd = ["codex", "exec"] + common
        if model:
            cmd += ["--model", model]
        cmd += [combined]
    return cmd


def extract_session_id(output: str) -> str:
    """Codex emits {"type":"thread.started","thread_id":"..."}."""
    for line in output.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "thread.started":
            tid = obj.get("thread_id", "")
            if tid:
                return tid
    return ""
