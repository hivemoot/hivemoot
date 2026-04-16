"""System prompt assembly for the hivemoot-github plugin."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_PLUGIN_ROOT = Path(__file__).resolve().parent
_AUTONOMOUS_PROMPT_PATH = _PLUGIN_ROOT / "prompts" / "autonomous.md"
_SOUL_PROMPT_PATH = _REPO_ROOT / "identities" / "hivemoot-agent" / "soul.md"


@lru_cache(maxsize=1)
def load_autonomous_prompt() -> str:
    """Load the shared autonomous Hivemoot contribution prompt."""
    return _AUTONOMOUS_PROMPT_PATH.read_text(encoding="utf-8").strip()


@lru_cache(maxsize=1)
def load_soul_prompt() -> str:
    """Load the Hivemoot identity guardrails and style prompt."""
    return _SOUL_PROMPT_PATH.read_text(encoding="utf-8").strip()


def build_system_prompt(
    *,
    target_repo: str = "",
    repo_path: str = "",
    clone_depth: int = 50,
    role_name: str = "",
    role_prompt_block: str = "",
) -> str:
    """Build the Hivemoot GitHub workflow prompt."""
    parts = [load_soul_prompt(), load_autonomous_prompt()]

    if role_prompt_block:
        parts.append(role_prompt_block.rstrip())

    if role_name:
        parts.append(
            f"Hivemoot buzz role: {role_name}\n"
            f"Use this role value when running: hivemoot buzz --role {role_name}"
        )

    if target_repo:
        context_lines = [
            f"Treat `{target_repo}` as the active Hivemoot governance target for this run.",
        ]
        if repo_path:
            context_lines.append(f"Local target repository path: `{repo_path}`")
        if clone_depth > 0:
            context_lines.append(
                f"Shallow clone (depth {clone_depth}) — `git log`/`git blame` "
                "are truncated. Run `git fetch --unshallow` if you need full history."
            )
        parts.append("\n".join(context_lines))

    return "\n\n".join(part for part in parts if part.strip())
