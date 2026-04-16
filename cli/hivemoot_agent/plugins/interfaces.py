"""Plugin system interfaces.

The engine runs inside a long-lived container.  Plugins provide
triggers (event sources) and handle agent execution (prompt building,
typing, response delivery).  The agent (Claude Code, etc.) runs as
a subprocess in the same container.

No host-side / container-side split.  Everything runs in one process.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


# ── Data classes ───────────────────────────────────────────────────


@dataclass
class PluginConfig:
    """Resolved configuration for a plugin instance."""

    name: str
    enabled: bool = True
    settings: dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        return self.settings.get(key, default)

    def require(self, key: str) -> Any:
        if key not in self.settings:
            raise ValueError(f"Plugin '{self.name}' missing required config: {key}")
        return self.settings[key]


@dataclass
class Skill:
    """A skill module loaded from a ``<name>/SKILL.md`` directory."""

    name: str
    content: str  # Full SKILL.md content (including frontmatter)
    source_dir: str = ""  # Absolute on-disk skill directory for native loading


@dataclass
class Job:
    """An inbound event to process."""

    session_key: str
    prompt: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentEvent:
    """A normalized streaming event from the agent subprocess.

    Providers parse their raw stdout into these.  Plugins react to
    the kind without knowing which provider emitted it.
    """

    kind: str           # "assistant_message", "tool_use", "tool_result", "system", "result"
    text: str = ""      # Primary text content
    tool_name: str = "" # For tool_use events


@dataclass
class AgentResult:
    """Result of an agent run."""

    exit_code: int
    response: str
    session_id: str = ""
    duration_secs: int = 0


# ── Protocols ──────────────────────────────────────────────────────


class JobDispatcher(Protocol):
    """Callback for triggers to submit jobs to the engine."""

    def dispatch(self, job: Job) -> bool:
        """Submit a job.  Returns True if accepted."""
        ...


@runtime_checkable
class Trigger(Protocol):
    """Listens for events and dispatches jobs."""

    name: str

    def validate(self, config: PluginConfig) -> list[str]:
        """Return config errors (empty = valid)."""
        ...

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        """Start listening.  Blocks until stop() is called."""
        ...

    def stop(self) -> None:
        """Stop listening."""
        ...


@runtime_checkable
class Plugin(Protocol):
    """A plugin bundles triggers and agent lifecycle handling.

    The plugin controls what happens before, during, and after the
    agent runs — all in the same process, same container.
    """

    name: str
    version: str
    description: str

    def validate(self, config: PluginConfig) -> list[str]:
        """Validate configuration."""
        ...

    def setup(self, config: PluginConfig) -> None:
        """One-time setup after validation (clone repos, auth, etc.).

        Called once before triggers start or oneshot runs.  Heavy work
        (network, disk) belongs here — not in on_job_started which
        fires on every inbound job.
        """
        ...

    def triggers(self) -> list[Trigger]:
        """Return triggers provided by this plugin."""
        ...


    def system_prompt(self, config: PluginConfig) -> str:
        """Persistent system context — injected into every agent run.

        Called once after setup().  The result is merged from all
        enabled plugins and reused across all jobs.

        Use for: mode instructions, repo paths, tool descriptions,
        skills, and other context that applies to every run.
        """
        ...

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        """Called when the agent starts working on a job.

        Use for: typing indicators, heartbeats, progress reporting.
        """
        ...

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        """Called when the agent finishes a job.

        Use for: send response to chat, report result to backend.
        """
        ...
