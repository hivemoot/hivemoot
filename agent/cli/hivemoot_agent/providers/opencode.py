"""OpenCode provider."""

from __future__ import annotations

import os

from hivemoot_agent.plugins.interfaces import AgentEvent

name = "opencode"
supports_system_prompt_flag = False
native_skill_backend = "workspace_agents_dir"

# Provider-specific model override (matches bash worker's OPENCODE_MODEL).
_MODEL_ENV = "OPENCODE_MODEL"


def build_cmd(
    prompt: str,
    system_prompt: str,
    model: str,
    mcp_config: str,
    session_id: str,
    **kwargs: str,
) -> list[str]:
    combined = f"{system_prompt}\n\n{prompt}"
    cmd = ["opencode", "run"]
    # Prefer OPENCODE_MODEL over the generic AGENT_MODEL passed as `model`.
    effective_model = os.environ.get(_MODEL_ENV, "") or model
    if effective_model:
        cmd += ["--model", effective_model]
    cmd += [combined]
    return cmd


def parse_event(line: str) -> AgentEvent | None:
    return None


def extract_session_id(output: str) -> str:
    return ""
