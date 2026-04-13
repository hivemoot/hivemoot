"""Gemini provider."""

from __future__ import annotations

import os

from hivemoot_agent.plugins.interfaces import AgentEvent

name = "gemini"
supports_system_prompt_flag = False


def build_cmd(
    prompt: str,
    system_prompt: str,
    model: str,
    mcp_config: str,
    session_id: str,
    **kwargs: str,
) -> list[str]:
    combined = f"{system_prompt}\n\n{prompt}"
    # In task mode use plain text output (the log IS the answer);
    # otherwise use stream-json for structured events / telemetry.
    task_mode = bool(os.environ.get("AGENT_TASK_ID", ""))
    output_fmt = "text" if task_mode else "stream-json"
    cmd = ["gemini", "--yolo", "--output-format", output_fmt, "-p", combined]
    if model:
        cmd += ["-m", model]
    return cmd


def parse_event(line: str) -> AgentEvent | None:
    return None


def extract_session_id(output: str) -> str:
    return ""
