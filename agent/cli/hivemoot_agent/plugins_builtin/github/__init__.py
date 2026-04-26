"""GitHub plugin — clone repos, inject context, develop on GitHub."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.github import ack as ack_module
from hivemoot_agent.plugins_builtin.github import pr_watcher
from hivemoot_agent.plugins_builtin.github.repo_manager import (
    RepoInfo,
    clone_or_sync,
    configure_git_user,
    repo_checkout_path,
    resolve_github_user,
)
from hivemoot_agent.plugins_builtin.github.system_prompt import build_system_prompt
from hivemoot_agent.plugins_builtin.github.trigger import (
    GitHubMentionsTrigger,
    GitHubNewPullRequestsTrigger,
    GitHubReviewRequestsTrigger,
)

if TYPE_CHECKING:
    from hivemoot_agent.plugins_builtin.github.config import GitHubConfig


def _configure_git_auth() -> None:
    """Configure git HTTPS auth through the authenticated gh CLI."""
    try:
        result = subprocess.run(
            ["gh", "auth", "setup-git"],
            capture_output=True,
            text=True,
            timeout=30,
            env=dict(os.environ),
        )
    except FileNotFoundError as exc:
        raise RuntimeError("gh CLI is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("gh auth setup-git timed out") from exc

    if result.returncode == 0:
        return

    detail = (result.stderr or result.stdout).strip()
    if not detail:
        detail = "gh auth setup-git exited without an error message"
    raise RuntimeError(detail)


def _validate_repo_access(repo: str, token: str) -> None:
    """Fail fast when the configured token cannot access a repo."""
    try:
        result = subprocess.run(
            ["gh", "api", f"repos/{repo}", "--jq", ".full_name"],
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "GH_TOKEN": token, "GITHUB_TOKEN": token},
        )
    except FileNotFoundError as exc:
        raise RuntimeError("gh CLI is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Timed out validating access to {repo}") from exc

    if result.returncode == 0:
        return

    detail = (result.stderr or result.stdout).strip()
    if not detail:
        detail = f"token cannot access {repo}"
    raise RuntimeError(f"Failed to validate access for {repo}: {detail}")


def _read_token(cfg: "GitHubConfig") -> str:
    """Read the GitHub token from the configured token_file, or ''.

    Returns empty string if no token_file is set or the file isn't
    readable — validate() reports the error upstream.  Kept as a tiny
    helper so setup/trigger/ack all resolve the token the same way.

    NOTE: Does NOT consult env. Subscriber-mode callers should use
    :func:`_read_token_runtime` which falls back to env. We keep this
    helper file-only because validate-time checks need a deterministic
    "is the file readable?" answer, separate from "is there a token
    available right now?".
    """
    if cfg.token_file is None:
        return ""
    try:
        return Path(cfg.token_file).read_text().strip()
    except OSError:
        return ""


def _read_token_runtime(cfg: "GitHubConfig") -> str:
    """Resolve the GitHub token at runtime, file or env per token_source.

    Two-mode resolution (apiarist Phase L'):

    - ``token_source: file`` — read from ``cfg.token_file`` (existing
      long-lived-PAT path).
    - ``token_source: subscriber`` — read from ``GH_TOKEN`` /
      ``GITHUB_TOKEN`` env, populated by the hivemoot apiarist auth
      subscriber.

    Used by hot paths (notification ack, gh API calls, etc.) that need
    "the currently valid token, whatever its source." Validate-time
    checks should keep using :func:`_read_token` because env state at
    validate time isn't representative of runtime.
    """
    if cfg.token_source == "subscriber":
        return os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    return _read_token(cfg)


class GitHubPlugin:
    name = "github"
    version = "0.2.0"
    description = "GitHub repository management and development"

    def __init__(self) -> None:
        self._repos: list[RepoInfo] = []
        self._git_name: str = ""
        self._git_email: str = ""
        self._setup_attempted = False
        # Cached typed config — captured in validate() / setup() so
        # triggers() (which has no config parameter in the Plugin
        # protocol) can read cfg.watch_* flags without reaching into
        # the global registry.
        self._cfg: GitHubConfig | None = None
        # Auth-dependent subscriber populated in setup_lifecycle() when
        # token_source: subscriber. Cached for diagnostics + tests; the
        # runtime path goes through engine.lifecycle directly.
        self._auth_subscriber: Any = None

    def validate(self, config: PluginConfig) -> list[str]:
        from hivemoot_agent.plugins_builtin.github.config import GitHubConfig

        cfg: GitHubConfig | None = config.typed
        if cfg is None:
            return [
                "github plugin requires typed config (plugins.github in "
                "hivemoot.yaml).  Env-var configuration was removed in 0.2.0."
            ]
        self._cfg = cfg

        errors: list[str] = []
        if not cfg.repos:
            errors.append("plugins.github.repos is required (list of owner/repo)")

        # token_file is REQUIRED only when token_source is "file" (the
        # default — long-lived PAT in a secrets file). Under
        # token_source: subscriber, the token arrives via env on every
        # job from another plugin's lifecycle subscriber (apiarist via
        # hivemoot), so an absent token_file is intentional and not an
        # error.
        if cfg.token_source == "file":
            if cfg.token_file is None:
                errors.append(
                    "plugins.github.token_file is required when "
                    "token_source is 'file' (typically "
                    "`!secret github_token`)"
                )
            elif not Path(cfg.token_file).is_file():
                errors.append(
                    f"plugins.github.token_file does not exist: {cfg.token_file}"
                )
            elif not _read_token(cfg):
                errors.append(
                    f"plugins.github.token_file is empty: {cfg.token_file}"
                )
        return errors

    def triggers(self) -> list[Trigger]:
        """Return watcher triggers per cfg.watch_* flags.

        validate()/setup() have already stashed ``self._cfg``; we only
        create trigger instances the operator actually enabled, so the
        engine never starts a thread that immediately no-ops.
        """
        cfg = self._cfg
        instances: list[Trigger] = []
        if cfg is None:
            return instances
        if cfg.watch_mentions:
            instances.append(GitHubMentionsTrigger(self))
        if cfg.watch_review_requests:
            instances.append(GitHubReviewRequestsTrigger(self))
        if cfg.watch_new_prs:
            instances.append(GitHubNewPullRequestsTrigger(self))
        return instances

    def setup(self, config: PluginConfig) -> None:
        """One-time plugin setup.

        Two-stage when ``token_source: subscriber`` (apiarist DESIGN.md
        §12.3):

        - ``token_source: file`` (default): runs both stages here. The
          token from ``token_file`` is available immediately; clone +
          validate happen synchronously. Existing PAT-based behavior.
        - ``token_source: subscriber``: runs ONLY the auth-free stage
          (cache config, choose git user defaults). The auth-required
          stage (clone, validate, configure git user) moves into
          :meth:`setup_lifecycle` which registers a subscriber that
          runs on every IDLE→ACTIVE boundary AFTER the upstream
          subscriber has populated env. ``self._repos`` stays empty
          until the first job; ``system_prompt()`` falls back to the
          placeholder path (config-derived) for the merged prompt.
        """
        from hivemoot_agent.plugins_builtin.github.config import GitHubConfig

        self._setup_attempted = True
        cfg: GitHubConfig | None = config.typed
        if cfg is None:
            raise RuntimeError(
                "github plugin setup called without typed config"
            )
        self._cfg = cfg

        # Auth-free defaults — git_name/email fallbacks. Don't resolve
        # from token here in subscriber mode; the subscriber's on_active
        # will refine these once the env is populated.
        if cfg.git_name:
            self._git_name = cfg.git_name
            self._git_email = cfg.git_email
        else:
            self._git_name = "hivemoot-agent"
            self._git_email = "hivemoot-agent@users.noreply.github.com"

        if cfg.token_source == "subscriber":
            # Auth-required steps deferred to setup_lifecycle / on_active.
            return

        # Legacy file-token path: auth-required steps run inline.
        token = _read_token(cfg)
        os.environ["GH_TOKEN"] = token
        os.environ["GITHUB_TOKEN"] = token
        self._auth_required_setup(cfg, token)

    def _auth_required_setup(
        self, cfg: "GitHubConfig", token: str,
    ) -> None:
        """Auth-required half of setup.

        Runs in two scenarios:

        - From :meth:`setup` when ``token_source: file`` (token loaded
          from disk; behavior unchanged from pre-subscriber refactor).
        - From the github auth-dependent subscriber's ``on_active``
          when ``token_source: subscriber`` (token loaded from env,
          populated by the upstream auth subscriber).

        Idempotent: ``clone_or_sync`` fetches an existing checkout
        instead of re-cloning; ``configure_git_user`` is a no-op when
        the values match. ``_validate_repo_access`` is one ``gh api``
        call per repo — the cost is acceptable per-job because it
        catches a stale/wrong token before the agent runs and burns
        a job slot on a confusing failure.
        """
        workspace = str(cfg.workspace)
        clone_depth = cfg.clone_depth
        repo_names = list(cfg.repos)

        # Refine git user from the live token if not pinned in config.
        # Only updates self._git_name/_email when resolve succeeds —
        # we keep the auth-free defaults when the API call fails (the
        # agent still gets a sane committer identity for the run).
        if not cfg.git_name:
            login, email = resolve_github_user(token)
            if login:
                self._git_name = login
                self._git_email = email

        try:
            _configure_git_auth()
        except RuntimeError as exc:
            raise RuntimeError(
                f"Failed to configure git credential helper: {exc}"
            ) from exc

        for repo in repo_names:
            _validate_repo_access(repo, token)

        cloned: list[RepoInfo] = []
        failures: list[str] = []
        for repo in repo_names:
            try:
                info = clone_or_sync(repo, workspace, token, clone_depth)
                configure_git_user(info.path, self._git_name, self._git_email)
                cloned.append(info)
                print(
                    f"[github] ready: {info.repo} → {info.path} "
                    f"(branch={info.default_branch})",
                    file=sys.stderr, flush=True,
                )
            except RuntimeError as exc:
                failures.append(f"{repo}: {exc}")
                print(
                    f"[github] clone failed: {repo}: {exc}",
                    file=sys.stderr, flush=True,
                )

        self._repos = cloned
        if failures:
            raise RuntimeError("; ".join(failures))

    def setup_lifecycle(
        self, lifecycle: Any, config: PluginConfig,
    ) -> None:
        """Optional engine hook: register the auth-dependent subscriber.

        Only registers when ``token_source: subscriber``. The subscriber's
        ``on_active`` reads ``GH_TOKEN`` from env (populated by the
        upstream auth subscriber, e.g. hivemoot's apiarist-backed one)
        and runs :meth:`_auth_required_setup` — clone/validate/configure.

        ``on_idle`` is a no-op for this subscriber: the cloned
        workspace is intentionally persistent across jobs (next job's
        on_active just fetches), and the env vars are owned by the
        upstream subscriber to clear.

        Registration order is load-bearing. The engine calls
        ``setup_lifecycle`` in plugin iteration order (matching
        ``hivemoot.yaml`` insertion order under ADR-003), and the
        operator MUST list the upstream auth subscriber's plugin
        BEFORE the github plugin so its ``on_active`` fires first
        (env populated → github sees it).
        """
        cfg = config.typed
        if cfg is None or cfg.token_source != "subscriber":
            return

        from hivemoot_agent.plugins_builtin.github.auth_subscriber import (
            GithubAuthDependentSubscriber,
        )

        subscriber = GithubAuthDependentSubscriber(self, cfg)
        lifecycle.subscribe(subscriber)
        # Cache for diagnostics + tests; the engine drives this via
        # lifecycle directly.
        self._auth_subscriber = subscriber
        print(
            "[github] registered auth-dependent subscriber "
            "(token_source: subscriber)",
            file=sys.stderr, flush=True,
        )

    def system_prompt(self, config: PluginConfig) -> str:
        from hivemoot_agent.plugins_builtin.github.config import GitHubConfig

        cfg: GitHubConfig | None = config.typed or self._cfg
        clone_depth = cfg.clone_depth if cfg else 50

        # Subscriber mode: setup() runs the auth-free half + sets
        # _setup_attempted, but _repos stays empty until first
        # IDLE→ACTIVE clones them. Without this branch the gate below
        # would take the empty-repos path for the first job's prompt
        # ("No repositories were pre-cloned"), since system_prompt() is
        # called once after setup() and reused across jobs. Falling
        # through to the placeholder builder gives the first job a
        # correct prompt with the deterministic repo paths; subsequent
        # process restarts (when _repos is populated) use the real
        # values via the next branch.
        if (
            cfg is not None
            and cfg.token_source == "subscriber"
            and not self._repos
        ):
            workspace = str(cfg.workspace)
            placeholder_repos = [
                RepoInfo(
                    repo=r,
                    path=repo_checkout_path(workspace, r),
                    default_branch="main",
                )
                for r in cfg.repos
            ]
            return build_system_prompt(
                placeholder_repos, clone_depth,
                git_user=self._git_name,
            )

        if self._repos or self._setup_attempted:
            return build_system_prompt(
                self._repos, clone_depth,
                git_user=self._git_name,
            )

        # Fallback: setup() hasn't run yet.  Build from config.
        if cfg is None:
            return build_system_prompt([], clone_depth)
        workspace = str(cfg.workspace)
        placeholder_repos = [
            RepoInfo(
                repo=r,
                path=repo_checkout_path(workspace, r),
                default_branch="main",
            )
            for r in cfg.repos
        ]
        return build_system_prompt(placeholder_repos, clone_depth)

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        pass

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig
    ) -> None:
        # Watch triggers tag their jobs with ack metadata; everything
        # else (oneshot, hivemoot.tasks) leaves it absent.
        watch_meta = job.metadata.get("github_watch") if job.metadata else None
        if not isinstance(watch_meta, dict):
            return

        # On agent failure we deliberately skip the ack — the shell
        # controller's same path: the next watch poll re-emits the event
        # and we retry.  Silently acking a failed run would lose the
        # notification and the work it represented.
        if result.exit_code != 0:
            print(
                f"[{watch_meta.get('trigger', 'github-watch')}] "
                f"agent failed (exit={result.exit_code}); skipping ack",
                file=sys.stderr, flush=True,
            )
            return

        # Coalesced path: the engine merged multiple events' ack
        # metadata into watch_meta["acks"] (a list of dicts), one per
        # source event.  Ack each one — a single flaky ack is logged
        # but does NOT abort the remaining acks, so one wedged state
        # file can't leave the other notifications unread.
        acks = watch_meta.get("acks")
        if isinstance(acks, list) and acks:
            for ack in acks:
                if isinstance(ack, dict):
                    self._perform_ack(ack, config)
            return

        # Legacy / single-event path: fall back to the top-level fields.
        # Kept so any job built without the coalesced-acks list (tests,
        # non-engine direct calls, future plugins) still acks correctly.
        self._perform_ack(watch_meta, config)

    def _perform_ack(
        self,
        ack: dict[str, Any],
        config: PluginConfig,
    ) -> None:
        """Dispatch one ack by strategy; swallow errors per-ack.

        Any exception from the underlying ack helper is logged and
        swallowed so a single flaky ack does not cancel the rest of
        the coalesced set.  The notification stays unread → next poll
        re-emits → retried.
        """
        ack_key = str(ack.get("ack_key") or "")
        state_file = str(ack.get("state_file") or "")
        ack_strategy = str(ack.get("ack_strategy") or "notification")
        trigger = str(ack.get("trigger") or "github-watch")
        if not ack_key or not state_file:
            return

        try:
            if ack_strategy == "notification":
                # Hot path — use the runtime resolver so subscriber-mode
                # services read the env-injected token rather than the
                # absent token_file. Without this, ack_event would skip
                # on empty token and the notification would replay
                # forever.
                gh_token = (
                    _read_token_runtime(config.typed) if config.typed else ""
                )
                ack_module.ack_event(ack_key, state_file, gh_token)
                return
            if ack_strategy == "new_pr":
                pr_watcher.ack_new_pr(ack_key, state_file)
                return
            print(
                f"[{trigger}] unknown ack strategy: {ack_strategy}",
                file=sys.stderr, flush=True,
            )
        except Exception as exc:
            print(
                f"[{trigger}] ack failed (key={ack_key}): "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr, flush=True,
            )


def create_plugin() -> Plugin:
    return GitHubPlugin()  # type: ignore[return-value]
