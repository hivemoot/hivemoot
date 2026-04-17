"""System prompt loader for the hivemoot-identity plugin."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path


_PLUGIN_ROOT = Path(__file__).resolve().parent
_SOUL_PROMPT_PATH = _PLUGIN_ROOT / "soul.md"


@lru_cache(maxsize=1)
def load_soul_prompt() -> str:
    """Load the Hivemoot identity guardrails and style prompt.

    Cached for the life of the process — the file is bundled with the
    plugin and never changes at runtime.
    """
    return _SOUL_PROMPT_PATH.read_text(encoding="utf-8").strip()
