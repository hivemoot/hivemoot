"""Lifecycle subscriber that runs the github plugin's auth-required
setup steps every IDLE→ACTIVE boundary.

Used only when ``plugins.github.token_source: subscriber`` (apiarist
DESIGN.md §12.3, Phase L'). The token isn't read from a file under
that mode — an upstream lifecycle subscriber (e.g. the hivemoot
plugin's apiarist auth subscriber) populates ``GH_TOKEN`` /
``GITHUB_TOKEN`` env vars at ``setup_lifecycle`` time and keeps
them populated for the container lifetime via a background refresh
thread. This subscriber registers AFTER the upstream one
(registration order is load-bearing — the operator lists the
upstream plugin BEFORE github in ``hivemoot.yaml``) and on each
on_active reads the current env to perform:

- Resolve the GitHub user from the token (refines git committer
  identity if not pinned in config).
- ``gh auth setup-git`` to wire the credential helper.
- ``gh api repos/<repo>`` for each configured repo (catches a stale
  or wrong-scope token before the agent runs and burns a job slot
  on a confusing failure).
- ``clone_or_sync`` per repo (idempotent — fetches an existing
  checkout instead of re-cloning).
- ``configure_git_user`` per cloned repo.

These steps are cheap per-job (~1-2 seconds) compared to the agent
subprocess runtime; the value of running them per-on_active is
fail-fast verification + a fresh fetch of upstream changes.

``on_idle`` is intentionally a no-op:

- The cloned workspace is persistent across jobs (next on_active
  fetches incrementally; clearing it would force a slow re-clone).
- The env vars are NOT cleared by anyone on idle in the always-on
  contract — the upstream apiarist subscriber keeps them populated
  for the container lifetime so trigger threads can poll between
  jobs. See ``hivemoot/auth_subscriber.py`` module docstring for
  the trade-off rationale.
"""

from __future__ import annotations

import os
import sys
from typing import TYPE_CHECKING

from hivemoot_agent.lifecycle import LifecycleSubscriber

if TYPE_CHECKING:
    from hivemoot_agent.plugins_builtin.github import GitHubPlugin
    from hivemoot_agent.plugins_builtin.github.config import GitHubConfig


class GithubAuthDependentSubscriber(LifecycleSubscriber):
    """Lifecycle subscriber that performs github auth-required setup
    steps using a token populated by an upstream subscriber.

    Holds a back-reference to the github plugin instance so it can
    delegate to :meth:`GitHubPlugin._auth_required_setup` (the same
    helper that ``token_source: file`` mode runs inline at setup time).
    Single source of truth for the auth-required steps lives on the
    plugin; this subscriber is the IDLE→ACTIVE driver.
    """

    def __init__(
        self,
        plugin: "GitHubPlugin",
        cfg: "GitHubConfig",
    ) -> None:
        if plugin is None:
            raise ValueError("plugin is required")
        if cfg is None:
            raise ValueError("cfg is required")
        self._plugin: "GitHubPlugin" = plugin
        self._cfg: "GitHubConfig" = cfg

    def on_active(self) -> None:
        """Read ``GH_TOKEN`` from env and run the auth-required setup.

        Raises ``RuntimeError`` when env is missing the token (upstream
        subscriber didn't fire, OR fired but failed to populate env).
        Lifecycle module rolls back the counter and tears down completed
        subscribers; the triggering job fails and runtime retries.

        Fail-closed is intentional. Anonymous git operations would
        succeed for public repos with read access but silently fail for
        anything write-related (push, PR, comment), and the agent would
        spend its budget on a job it can't complete.
        """
        token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
        if not token:
            raise RuntimeError(
                "github auth subscriber: GH_TOKEN / GITHUB_TOKEN env "
                "not set. The upstream auth subscriber (e.g. hivemoot "
                "with apiarist) must populate the env BEFORE this "
                "subscriber's on_active fires. Check plugin "
                "registration order in hivemoot.yaml — the upstream "
                "plugin must be listed BEFORE 'github'."
            )

        self._plugin._auth_required_setup(self._cfg, token)
        print(
            f"[github] auth-dependent setup completed for "
            f"{len(self._cfg.repos)} repo(s)",
            file=sys.stderr, flush=True,
        )

    def on_idle(self) -> None:
        """No-op — see module docstring for why.

        The cloned workspace persists across jobs by design (next
        on_active fetches incrementally), and env-var ownership stays
        with the upstream auth subscriber.
        """
        return None


__all__ = ["GithubAuthDependentSubscriber"]
