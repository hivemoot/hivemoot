"""Claude Code provider."""

from __future__ import annotations

import json

from hivemoot_agent.plugins.interfaces import AgentEvent

name = "claude"
supports_system_prompt_flag = True
native_skill_backend = "claude_plugin_dir"

# Deny rules block naive single-command exfiltration from prompt injection.
# Enforced even with --dangerously-skip-permissions.  Container isolation
# is the primary defense; these are defense-in-depth.  See issue #94.
_DISALLOWED_TOOLS = [
    "Bash(env)",
    "Bash(env *)",
    "Bash(printenv)",
    "Bash(printenv *)",
    "Bash(set)",
    "Bash(set *)",
    "Bash(export)",
    "Bash(export *)",
    "Bash(declare)",
    "Bash(declare *)",
    "Bash(cat /run/secrets/*)",
    "Bash(* /run/secrets/*)",
    "Read(/run/secrets/*)",
    "Bash(cat /proc/*/environ)",
    "Bash(* /proc/*/environ)",
    "Read(/proc/*/environ)",
]


def build_cmd(
    prompt: str,
    system_prompt: str,
    model: str,
    mcp_config: str,
    session_id: str,
    *,
    plugin_dir: str = "",
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
    for tool in _DISALLOWED_TOOLS:
        cmd += ["--disallowedTools", tool]
    if mcp_config:
        cmd += ["--mcp-config", mcp_config]
    if plugin_dir:
        cmd += ["--plugin-dir", plugin_dir]
    if model:
        cmd += ["--model", model]
    cmd += ["--", prompt]
    return cmd


def parse_event(line: str) -> AgentEvent | None:
    """Parse a Claude stream-json line into a normalized event.

    Claude's --output-format stream-json emits JSONL with types:
    system, assistant, result. Assistant messages can mix a short
    text preamble with a tool_use block; when text is present we keep
    it as an assistant_message so progress updates still surface.
    """
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None

    msg_type = obj.get("type", "")

    if msg_type == "system":
        return AgentEvent(kind="system")

    if msg_type == "assistant":
        content = obj.get("message", {}).get("content", [])
        text = ""
        tool_name = ""
        for block in content:
            block_type = block.get("type", "")
            if block_type == "text" and not text:
                text = block.get("text", "")
            elif block_type == "tool_use" and not tool_name:
                tool_name = block.get("name", "")
        if text:
            return AgentEvent(
                kind="assistant_message",
                text=text,
                tool_name=tool_name,
            )
        if tool_name:
            return AgentEvent(kind="tool_use", text=text, tool_name=tool_name)
        return AgentEvent(kind="assistant_message")

    if msg_type == "result":
        return AgentEvent(kind="result", text=obj.get("result", ""))

    return None


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
