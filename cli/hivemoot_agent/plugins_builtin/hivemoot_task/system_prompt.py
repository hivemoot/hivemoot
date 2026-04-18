"""System prompt assembly for the hivemoot-task plugin.

Deliberately minimal: the task operating-mode prompt lives in
``prompts/task.md`` and is repo-agnostic.  The plugin does not know
(and does not want to know) what the task is about — that's the
backend's responsibility, baked into the per-task prompt body that
the trigger renders and passes as ``Job.prompt``.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path


_PLUGIN_ROOT = Path(__file__).resolve().parent
_TASK_PROMPT_PATH = _PLUGIN_ROOT / "prompts" / "task.md"


@lru_cache(maxsize=1)
def load_task_prompt() -> str:
    """Load the task operating-mode prompt."""
    return _TASK_PROMPT_PATH.read_text(encoding="utf-8").strip()


def build_system_prompt() -> str:
    """Return the task operating-mode prompt with no per-run context.

    Soul guardrails come from the ``hivemoot-identity`` plugin when it's
    stacked ahead of this one; other plugins (github, hivemoot-github)
    contribute their own system prompts independently and the engine
    merges them all.  This plugin only adds the task operating mode.
    """
    return load_task_prompt()
