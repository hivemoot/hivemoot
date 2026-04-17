"""System prompt assembly for the hivemoot-task plugin."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path


_PLUGIN_ROOT = Path(__file__).resolve().parent
_TASK_PROMPT_PATH = _PLUGIN_ROOT / "prompts" / "task.md"


@lru_cache(maxsize=1)
def load_task_prompt() -> str:
    """Load the task operating-mode prompt."""
    return _TASK_PROMPT_PATH.read_text(encoding="utf-8").strip()


def build_system_prompt(
    *,
    target_repo: str = "",
    repo_path: str = "",
) -> str:
    """Build the Hivemoot delegated-task prompt.

    Soul guardrails come from the `hivemoot-identity` plugin when it's
    stacked ahead of this one; the github plugin contributes repo paths
    and the shallow-clone note. This plugin only adds the task operating
    mode and a narrow "this is the task target" framing so the agent
    knows which repo is in scope for the claim.
    """
    parts = [load_task_prompt()]

    if target_repo:
        context_lines = [
            f"Target repository for this task: `{target_repo}`.",
        ]
        if repo_path:
            context_lines.append(f"Local repository path: `{repo_path}`.")
        parts.append("\n".join(context_lines))

    return "\n\n".join(part for part in parts if part.strip())
