"""OpenCode provider."""

from __future__ import annotations

name = "opencode"
supports_system_prompt_flag = False


def build_cmd(
    prompt: str,
    system_prompt: str,
    model: str,
    mcp_config: str,
    session_id: str,
) -> list[str]:
    combined = f"{system_prompt}\n\n{prompt}"
    cmd = ["opencode", "run"]
    if model:
        cmd += ["--model", model]
    cmd += [combined]
    return cmd


def extract_session_id(output: str) -> str:
    return ""
