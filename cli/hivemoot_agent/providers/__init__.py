"""Provider abstraction — each AI provider gets its own module.

The engine calls provider.build_cmd() and provider.extract_session_id()
instead of branching on provider name strings.  Adding a new provider
means dropping a file in this package and registering it in PROVIDERS.

Each provider module exposes:
    build_cmd(prompt, system_prompt, model, mcp_config, session_id) -> list[str]
    extract_session_id(output) -> str
    supports_system_prompt_flag -> bool  (can pass system prompt separately)
"""

from __future__ import annotations

from typing import Protocol

from hivemoot_agent.plugins.interfaces import AgentEvent


class Provider(Protocol):
    """What every provider module must expose."""

    name: str

    # True if the provider accepts system prompt as a separate flag
    # (e.g., Claude's --append-system-prompt).  False if system prompt
    # must be concatenated with the user prompt.
    supports_system_prompt_flag: bool

    def build_cmd(
        self,
        prompt: str,
        system_prompt: str,
        model: str,
        mcp_config: str,
        session_id: str,
    ) -> list[str]:
        """Build the CLI command to run this provider."""
        ...

    def extract_session_id(self, output: str) -> str:
        """Extract a resumable session/thread ID from stdout.

        Returns "" if the provider doesn't emit session IDs or
        none was found in the output.
        """
        ...

    def parse_event(self, line: str) -> AgentEvent | None:
        """Parse a single stdout line into a normalized event.

        Returns None for lines that don't map to a recognized event.
        """
        ...


# ── Registry ─────────────────────────────────────────────────────

from hivemoot_agent.providers import claude, codex, gemini, kilo, opencode

PROVIDERS: dict[str, Provider] = {
    "claude": claude,
    "codex": codex,
    "gemini": gemini,
    "kilo": kilo,
    "opencode": opencode,
}


def get(name: str) -> Provider | None:
    """Look up a provider by name.  Returns None for unknown providers."""
    return PROVIDERS.get(name)
