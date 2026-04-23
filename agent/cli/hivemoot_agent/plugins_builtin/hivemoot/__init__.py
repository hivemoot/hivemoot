"""Consolidated Hivemoot ecosystem plugin.

One plugin, three independently-toggleable features:

  * ``health`` — periodic heartbeats + per-run reports to
    ``POST {base_url}/api/agent-health`` (dashboard Agent Health tab).
  * ``tasks`` — claim tasks from ``{claim_url}``, dispatch as Jobs,
    post per-task progress / heartbeat / outcome to the tasks API.
  * ``github_workflows`` — autonomous contribution operating mode,
    buzz role loading, skill bundle.  Co-loads with the ``github``
    plugin (reads its typed config for the target repo).

YAML shape (``hivemoot.yaml``):

    plugins:
      hivemoot:
        token_file: !secret hivemoot_agent_token
        health:
          enabled: true
          repo: hivemoot/hivemoot
        tasks:
          enabled: true
          claim_url: https://www.hivemoot.dev/api/tasks/claim
          execute_base_url: https://www.hivemoot.dev/api/tasks
        github_workflows:
          enabled: true

Host behaviour is plugin-agnostic per ADR-002; this plugin owns its
full vertical slice (triggers, lifecycle hooks, system prompts,
skills).
"""

from __future__ import annotations

import os
import shutil
import sys
import threading
import time
import uuid
from typing import TYPE_CHECKING, Any

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)

if TYPE_CHECKING:
    from hivemoot_agent.plugins_builtin.hivemoot.config import (
        HivemootConfig,
    )


# ── Helpers ────────────────────────────────────────────────────────


def _cfg_of(config: PluginConfig) -> "HivemootConfig | None":
    return config.typed


def _health_run_outcome(exit_code: int) -> str:
    """Map an engine exit code to the contract's outcome enum."""
    if exit_code == 0:
        return "success"
    if exit_code == 124:
        return "timeout"
    return "failure"


def _health_trigger_label(job: Job) -> str:
    """Derive the AGENT_HEALTH_CONTRACT trigger enum value from a Job.

    Returns empty string when we don't know — the server treats absent
    as "unknown" rather than a validation error.
    """
    key = job.session_key or ""
    if key.startswith("task:"):
        return "task"
    if key.startswith("mention:"):
        return "mention"
    if key.startswith("manual:"):
        return "manual"
    return "scheduled"


def _is_task_job(job: Job) -> bool:
    return bool(job.metadata.get("task_id")) and bool(
        job.metadata.get("claim_token")
    )


# ── Plugin class ───────────────────────────────────────────────────


class HivemootPlugin:
    name = "hivemoot"
    version = "0.1.0"
    description = (
        "Hivemoot ecosystem integration — health reports, delegated "
        "tasks, and GitHub contribution workflow (feature-toggled)."
    )

    def __init__(self) -> None:
        # ── Task subsystem state ─────────────────────────────────
        # Per-job heartbeat state — overwritten on each on_job_started
        # so an orphan thread from a slow shutdown cannot be revived by
        # the next job (its closure-captured task_id would post for the
        # wrong task otherwise).
        self._task_heartbeat_stop: threading.Event | None = None
        self._task_heartbeat_thread: threading.Thread | None = None
        # Codex sidecar path resolved at job-start, consumed at finish.
        self._codex_sidecar_path: str = ""
        # In-flight gate for the async dispatcher.  The engine's
        # JobDispatcher.dispatch returns after enqueue, not after
        # on_job_finished — without this the claim loop would pre-
        # claim backend tasks that then sit silent in the workqueue
        # with no progress posts firing.  The trigger acquires the
        # slot (clear) just before dispatch; on_job_finished releases
        # it (set).  Starts set so the first claim is unblocked.
        self._task_inflight: threading.Event = threading.Event()
        self._task_inflight.set()

        # ── GitHub-workflows subsystem state ─────────────────────
        self._target_repo: str = ""
        self._repo_path: str = ""
        self._role_name: str = ""
        self._role_prompt_block: str = ""

        # ── Health subsystem state ───────────────────────────────
        # Per-job correlation keyed by session_key so a future change
        # to engine serialization (currently per #605) cannot mix up
        # run ids between concurrent jobs.
        self._run_started_at: dict[str, float] = {}
        self._run_ids: dict[str, str] = {}
        self._consecutive_failures: int = 0
        # Rate limiter for "identity unresolvable" warnings so a
        # rolling token unmount doesn't flood stderr.
        self._last_health_warn_at: float = 0.0
        self._health_warn_min_interval_secs: float = 60.0

        # Cached typed config — populated in validate()/setup() so the
        # triggers/system_prompt methods don't re-read from the registry.
        self._cfg: "HivemootConfig | None" = None

    # ── Validation / setup ─────────────────────────────────────────

    def validate(self, config: PluginConfig) -> list[str]:
        cfg: "HivemootConfig | None" = config.typed
        if cfg is None:
            return [
                "hivemoot plugin requires typed config (plugins.hivemoot "
                "in hivemoot.yaml)."
            ]
        self._cfg = cfg

        errors: list[str] = []

        if cfg.health.enabled:
            errors.extend(self._validate_health(cfg))
        if cfg.tasks.enabled:
            errors.extend(self._validate_tasks(cfg))
        if cfg.github_workflows.enabled:
            errors.extend(self._validate_github_workflows(cfg))

        return errors

    def _validate_health(self, cfg: "HivemootConfig") -> list[str]:
        errors: list[str] = []
        if not cfg.health.base_url:
            errors.append(
                "plugins.hivemoot.health.base_url is required when "
                "health.enabled is true"
            )
        repo = self._resolve_health_repo(cfg)
        if not repo:
            errors.append(
                "plugins.hivemoot.health.repo is required (or set "
                "plugins.github.repos[0]) when health.enabled is true"
            )
        if cfg.token_file is None and not (
            os.environ.get("HIVEMOOT_AGENT_TOKEN_FILE")
            or os.environ.get("HIVEMOOT_AGENT_TOKEN")
        ):
            errors.append(
                "plugins.hivemoot.token_file (or HIVEMOOT_AGENT_TOKEN"
                "{,_FILE} env) is required when health.enabled is true"
            )
        agent_id = self.resolved_agent_id()
        if not agent_id:
            errors.append(
                "AGENT_ID env var is required when health.enabled is "
                "true (used as the contract's agent_id field)"
            )
        return errors

    def _validate_tasks(self, cfg: "HivemootConfig") -> list[str]:
        errors: list[str] = []
        if not cfg.tasks.claim_url:
            errors.append(
                "plugins.hivemoot.tasks.claim_url is required when "
                "tasks.enabled is true"
            )
        if not cfg.tasks.execute_base_url:
            errors.append(
                "plugins.hivemoot.tasks.execute_base_url is required "
                "when tasks.enabled is true"
            )
        if cfg.token_file is None and not (
            os.environ.get("HIVEMOOT_AGENT_TOKEN_FILE")
            or os.environ.get("HIVEMOOT_AGENT_TOKEN")
        ):
            errors.append(
                "plugins.hivemoot.token_file (or HIVEMOOT_AGENT_TOKEN"
                "{,_FILE} env) is required when tasks.enabled is true"
            )
        return errors

    def _validate_github_workflows(self, cfg: "HivemootConfig") -> list[str]:
        """Mirrors the previous hivemoot-github plugin's validation.

        Requires the ``github`` plugin to be activated BEFORE
        ``hivemoot`` in the YAML so repos are cloned by the time our
        setup runs.
        """
        errors: list[str] = []

        from hivemoot_agent.plugins import registry as _registry
        already_configured = _registry.configured_names()
        if "github" not in already_configured:
            errors.append(
                "hivemoot.github_workflows requires the ``github`` plugin "
                "to be activated AND listed BEFORE ``hivemoot`` in "
                "plugins: of hivemoot.yaml so repos are cloned before "
                "this plugin's setup runs.  Currently configured before "
                f"us: {already_configured or '(none)'}."
            )
            return errors

        target_repo = self._resolve_github_target_repo()
        if not target_repo:
            errors.append(
                "hivemoot.github_workflows could not determine the "
                "target repository from the github plugin's typed config "
                "(plugins.github.repos is empty)."
            )

        if shutil.which("hivemoot") is None:
            errors.append(
                "hivemoot.github_workflows requires the hivemoot CLI in "
                "PATH (used by the role loader)."
            )

        return errors

    def setup(self, config: PluginConfig) -> None:
        cfg: "HivemootConfig | None" = config.typed
        if cfg is None:
            raise RuntimeError("hivemoot setup called without typed config")
        self._cfg = cfg

        if cfg.github_workflows.enabled:
            self._setup_github_workflows(cfg)

    def _setup_github_workflows(self, cfg: "HivemootConfig") -> None:
        """Resolve target repo path + optional role prompt block."""
        from hivemoot_agent.plugins_builtin.github.repo_manager import (
            repo_checkout_path,
        )
        from hivemoot_agent.plugins_builtin.hivemoot.github_workflows.role_loader import (
            RoleLoadError,
            load_role_prompt_block,
        )

        target_repo = self._resolve_github_target_repo()
        if not target_repo:
            raise RuntimeError(
                "hivemoot.github_workflows could not determine target "
                "repository from the github plugin's typed config."
            )
        self._target_repo = target_repo

        repo_path = repo_checkout_path(
            str(cfg.github_workflows.workspace), target_repo,
        )
        if not repo_path or not os.path.isdir(repo_path):
            raise RuntimeError(
                "hivemoot.github_workflows expected the github plugin to "
                f"clone {target_repo} at "
                f"{repo_path or '(unknown path)'}"
            )
        self._repo_path = repo_path

        self._role_name = self._resolve_role_name(cfg)
        self._role_prompt_block = ""
        if not self._role_name:
            return

        try:
            self._role_prompt_block = load_role_prompt_block(
                self._role_name, target_repo,
            )
        except RoleLoadError as exc:
            print(
                "[hivemoot] warning: failed to resolve role "
                f"{self._role_name} for {target_repo}: {exc}",
                file=sys.stderr, flush=True,
            )

    # ── Triggers / system prompt ──────────────────────────────────

    def triggers(self) -> list[Trigger]:
        cfg = self._cfg
        if cfg is None:
            return []
        triggers: list[Trigger] = []

        if cfg.tasks.enabled and cfg.tasks.claim_url:
            from hivemoot_agent.plugins_builtin.hivemoot.tasks.trigger import (
                HivemootTaskTrigger,
            )
            triggers.append(HivemootTaskTrigger(self))  # type: ignore[arg-type]

        if cfg.health.enabled:
            from hivemoot_agent.plugins_builtin.hivemoot.health.trigger import (
                HealthHeartbeatTrigger,
            )
            triggers.append(HealthHeartbeatTrigger(self))  # type: ignore[arg-type]

        return triggers

    def system_prompt(self, config: PluginConfig) -> str:
        cfg = self._cfg or _cfg_of(config)
        if cfg is None:
            return ""

        parts: list[str] = []

        if cfg.tasks.enabled:
            from hivemoot_agent.plugins_builtin.hivemoot.tasks.system_prompt import (
                build_system_prompt as build_task_prompt,
            )
            parts.append(build_task_prompt())

        if cfg.github_workflows.enabled:
            from hivemoot_agent.plugins_builtin.hivemoot.github_workflows.system_prompt import (
                build_system_prompt as build_github_prompt,
            )
            parts.append(
                build_github_prompt(
                    target_repo=self._target_repo,
                    repo_path=self._repo_path,
                    clone_depth=cfg.github_workflows.clone_depth,
                    role_name=self._role_name,
                    role_prompt_block=self._role_prompt_block,
                )
            )

        return "\n\n".join(part for part in parts if part.strip())

    # ── Per-job lifecycle ─────────────────────────────────────────

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        cfg = _cfg_of(config) or self._cfg

        if cfg is None:
            return

        # Health side channel runs first so a failure there never
        # blocks the tasks subsystem's progress post.
        if cfg.health.enabled:
            try:
                self._health_on_job_started(job)
            except Exception as exc:
                print(
                    f"[hivemoot-health] on_job_started raised: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr, flush=True,
                )

        if cfg.tasks.enabled and _is_task_job(job):
            try:
                self._task_on_job_started(job, config)
            except Exception as exc:
                print(
                    f"[hivemoot-tasks] on_job_started raised for "
                    f"{job.metadata.get('task_id')}: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr, flush=True,
                )

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig,
    ) -> None:
        cfg = _cfg_of(config) or self._cfg
        if cfg is None:
            return

        # Tasks outcome must be posted before the health run-report so
        # the dashboard task view is up-to-date before the health view
        # catches up.  Both wrapped independently — one failing must
        # not skip the other.
        if cfg.tasks.enabled and _is_task_job(job):
            try:
                self._task_on_job_finished(job, result, config)
            except Exception as exc:
                print(
                    f"[hivemoot-tasks] on_job_finished raised for "
                    f"{job.metadata.get('task_id')}: "
                    f"{type(exc).__name__}: {exc}; attempting bare "
                    "fail post",
                    file=sys.stderr, flush=True,
                )
                self._task_best_effort_fail(job, config, str(exc))
            finally:
                # Release the in-flight gate no matter what — the
                # trigger blocks on this and would hang forever if a
                # failure in _task_on_job_finished / _best_effort_fail
                # skipped the release.
                self.release_task_slot()

        if cfg.health.enabled and cfg.health.post_run_reports:
            try:
                self._health_on_job_finished(job, result)
            except Exception as exc:
                print(
                    f"[hivemoot-health] on_job_finished raised: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr, flush=True,
                )

    # ── Helpers used by triggers ──────────────────────────────────

    def resolved_agent_id(self) -> str:
        """Return the AGENT_ID env var, stripped."""
        return (os.environ.get("AGENT_ID", "") or "").strip()

    def resolved_health_repo(self) -> str:
        """Return the configured health repo, falling back to
        the github plugin's ``repos[0]``.  Empty when neither is set."""
        cfg = self._cfg
        if cfg is None:
            return ""
        return self._resolve_health_repo(cfg)

    # ── In-flight gate for the tasks trigger ──────────────────────

    def wait_task_slot(
        self, stop_event: threading.Event, timeout: float = 1.0,
    ) -> bool:
        """Block until the plugin is free to accept a new task.

        Returns True when the slot is available, False on timeout
        (trigger should loop back to check its own stop condition).
        Honours a shared ``stop_event`` by returning False immediately
        when set so shutdown doesn't wait out a full heartbeat.
        """
        if stop_event.is_set():
            return False
        return self._task_inflight.wait(timeout=timeout)

    def reserve_task_slot(self) -> None:
        """Mark the plugin as busy with a task.  Trigger calls this
        immediately before ``dispatcher.dispatch`` so a follow-up
        claim cannot run until ``release_task_slot`` fires."""
        self._task_inflight.clear()

    def release_task_slot(self) -> None:
        """Mark the plugin as ready for another claim.  Called from
        ``on_job_finished``'s finally block and from the trigger's
        dispatch-failed path."""
        self._task_inflight.set()

    # ── Private: shared resolvers ─────────────────────────────────

    def _resolve_health_repo(self, cfg: "HivemootConfig") -> str:
        if cfg.health.repo:
            return cfg.health.repo
        # Fall back to github plugin's repos[0].
        try:
            from hivemoot_agent.plugins import registry as _registry
            gh_cfg = _registry.config_for_or_none("github")
        except Exception:
            return ""
        if gh_cfg is None or gh_cfg.typed is None:
            return ""
        repos = getattr(gh_cfg.typed, "repos", None) or []
        return repos[0] if repos else ""

    def _resolve_github_target_repo(self) -> str:
        try:
            from hivemoot_agent.plugins import registry as _registry
            gh_cfg = _registry.config_for_or_none("github")
        except Exception:
            return ""
        if gh_cfg is None or gh_cfg.typed is None:
            return ""
        repos = getattr(gh_cfg.typed, "repos", None) or []
        return repos[0] if repos else ""

    def _resolve_role_name(self, cfg: "HivemootConfig") -> str:
        """role_name override, falling back to AGENT_ID env.

        Matches the historical HIVEMOOT_BUZZ_ROLE behaviour: deployers
        typically run one role per container, so AGENT_ID is the right
        default.  An explicit ``role_name`` in YAML wins for fleets
        that want a role distinct from the agent identity.
        """
        if cfg.github_workflows.role_name:
            return cfg.github_workflows.role_name
        return self.resolved_agent_id()

    # ── Private: health side channel ──────────────────────────────

    def _health_on_job_started(self, job: Job) -> None:
        """Record the run id + start time for this job, keyed by
        ``session_key`` so a future change to engine serialization
        (currently serialized per #605) cannot mix up run ids
        between concurrent jobs.
        """
        key = job.session_key or ""
        self._run_ids[key] = str(uuid.uuid4())
        self._run_started_at[key] = time.monotonic()

    def _health_on_job_finished(self, job: Job, result: AgentResult) -> None:
        """Post a run report for the just-completed job."""
        cfg = self._cfg
        if cfg is None:
            return

        from hivemoot_agent.plugins_builtin.hivemoot.auth import (
            resolve_agent_token,
        )
        from hivemoot_agent.plugins_builtin.hivemoot.health import api
        from hivemoot_agent.plugins_builtin.hivemoot.sanitize import (
            redact_secrets,
        )

        key = job.session_key or ""
        run_id = self._run_ids.pop(key, "") or str(uuid.uuid4())
        started_at = self._run_started_at.pop(key, 0.0)
        duration_secs = (
            max(0, int(time.monotonic() - started_at)) if started_at else 0
        )
        # Cap at contract max (86400).
        duration_secs = min(duration_secs, 86400)

        outcome = _health_run_outcome(result.exit_code)
        if outcome == "success":
            self._consecutive_failures = 0
        else:
            self._consecutive_failures += 1

        agent_id = self.resolved_agent_id()
        repo = self._resolve_health_repo(cfg)
        bearer = resolve_agent_token(
            str(cfg.token_file) if cfg.token_file else "",
        )

        if not agent_id or not repo or not bearer:
            # validate() caught this at startup, but the token file
            # can disappear (rolling restart, bad rotation) or
            # AGENT_ID can get unset by a config reload.  Log once
            # per interval so the operator sees dashboard silence
            # correlates with an agent-side signal instead of
            # chasing an unexplained gap.
            now = time.monotonic()
            if (
                now - self._last_health_warn_at
                >= self._health_warn_min_interval_secs
            ):
                missing = [
                    n for n, v in (
                        ("AGENT_ID", agent_id),
                        ("repo", repo),
                        ("bearer token", bearer),
                    ) if not v
                ]
                print(
                    "[hivemoot-health] run report skipped — missing "
                    f"{', '.join(missing)}; dashboard will show a gap "
                    "until this is resolved.",
                    file=sys.stderr, flush=True,
                )
                self._last_health_warn_at = now
            return

        error_text = ""
        if outcome != "success":
            # result.response is the agent's final message on failure;
            # it can echo env values, tool-output fragments, or short
            # secrets (Bearer/sk-*/token=).  Scrub the well-known
            # patterns before sending — the 256-char truncation in
            # health.api caps long spills but doesn't stop a short
            # leaked token at the head of the string.
            error_text = redact_secrets((result.response or "").strip())

        trigger_label = _health_trigger_label(job)

        ok = api.post_run_report(
            cfg.health.base_url,
            bearer,
            agent_id=agent_id,
            repo=repo,
            run_id=run_id,
            outcome=outcome,
            duration_secs=duration_secs,
            consecutive_failures=self._consecutive_failures,
            exit_code=result.exit_code,
            error=error_text,
            trigger=trigger_label,
        )
        if not ok:
            print(
                f"[hivemoot-health] run-report post returned non-200 "
                f"(agent={agent_id} repo={repo} run={run_id})",
                file=sys.stderr, flush=True,
            )
        # Per-job state was popped above so there's nothing to reset.

    # ── Private: task subsystem ───────────────────────────────────

    def _task_on_job_started(self, job: Job, config: PluginConfig) -> None:
        from hivemoot_agent.plugins_builtin.hivemoot.auth import (
            resolve_agent_token,
        )
        from hivemoot_agent.plugins_builtin.hivemoot.tasks import api

        cfg = self._cfg
        task_id = str(job.metadata.get("task_id") or "")
        claim_token = str(job.metadata.get("claim_token") or "")
        execute_base = cfg.tasks.execute_base_url if cfg else ""

        if not task_id or not claim_token or not execute_base:
            self._codex_sidecar_path = ""
            return

        bearer = resolve_agent_token(
            str(cfg.token_file) if cfg and cfg.token_file else "",
        )
        interval = cfg.tasks.heartbeat_interval_secs if cfg else 45

        # Codex writes its final markdown to a sidecar when invoked
        # with --output-last-message; remember the path so finish can
        # pick it up, and export CODEX_ANSWER_FILE so providers/codex.py
        # wires the flag.  AGENT_PROVIDER is engine-level, not plugin
        # config — read from settings (env) rather than the typed schema.
        provider = config.get("AGENT_PROVIDER", "claude")
        if provider == "codex":
            workspace = str(cfg.tasks.workspace) if cfg else "/workspace"
            self._codex_sidecar_path = os.path.join(
                workspace, "task-output", task_id, "codex-answer.md",
            )
            os.makedirs(
                os.path.dirname(self._codex_sidecar_path), exist_ok=True,
            )
            os.environ["CODEX_ANSWER_FILE"] = self._codex_sidecar_path
        else:
            self._codex_sidecar_path = ""
            os.environ.pop("CODEX_ANSWER_FILE", None)

        if not api.post_progress(
            execute_base, task_id, bearer, claim_token,
            f"Task {task_id} claimed. Starting execution.",
        ):
            print(
                f"[hivemoot-tasks] failed to post initial progress for "
                f"task {task_id}",
                file=sys.stderr, flush=True,
            )

        # interval=0 disables heartbeats; skip thread startup entirely
        # to avoid a tight Event.wait(0) busy loop.
        if interval <= 0:
            self._task_heartbeat_stop = None
            self._task_heartbeat_thread = None
            return

        # Per-job stop event so an orphaned thread from a slow shutdown
        # cannot post heartbeats for a stale task_id once the next job
        # starts.  Pass the token *file*, not the resolved bearer, so
        # the heartbeat loop re-resolves per tick — an operator
        # rotating HIVEMOOT_AGENT_TOKEN{,_FILE} takes effect within
        # one interval instead of waiting for process restart.
        token_file = str(cfg.token_file) if cfg and cfg.token_file else ""
        stop_event = threading.Event()
        self._task_heartbeat_stop = stop_event
        self._task_heartbeat_thread = threading.Thread(
            target=self._task_heartbeat_loop,
            args=(execute_base, task_id, token_file, claim_token, interval, stop_event),
            daemon=True,
        )
        self._task_heartbeat_thread.start()

    def _task_on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig,
    ) -> None:
        from hivemoot_agent.plugins_builtin.hivemoot.auth import (
            resolve_agent_token,
        )
        from hivemoot_agent.plugins_builtin.hivemoot.tasks import (
            api,
            auth_errors,
            result_extractor,
        )

        # Stop the heartbeat first so it can't race with the final post.
        stop_event = self._task_heartbeat_stop
        thread = self._task_heartbeat_thread
        self._task_heartbeat_stop = None
        self._task_heartbeat_thread = None
        if stop_event is not None:
            stop_event.set()
        if thread is not None:
            thread.join(timeout=5)

        cfg = self._cfg
        task_id = str(job.metadata.get("task_id") or "")
        claim_token = str(job.metadata.get("claim_token") or "")
        execute_base = cfg.tasks.execute_base_url if cfg else ""

        if not task_id or not claim_token or not execute_base:
            return

        bearer = resolve_agent_token(
            str(cfg.token_file) if cfg and cfg.token_file else "",
        )

        provider = config.get("AGENT_PROVIDER", "claude")
        log_path = self._resolve_provider_log_path(config)
        sidecar = self._codex_sidecar_path

        markdown = result_extractor.extract_result(
            provider, log_path, sidecar_path=sidecar,
        )

        exit_code = result.exit_code

        # Codex sometimes exits 0 with no output when its auth state is
        # broken.  Promote those to failure so the operator sees the
        # actual problem instead of an empty "task completed".
        if exit_code == 0 and provider == "codex" and not markdown:
            auth_code = auth_errors.detect_codex_auth_error(log_path)
            if auth_code:
                print(
                    f"[hivemoot-tasks] codex auth error '{auth_code}' "
                    f"detected in task {task_id}; promoting to failure",
                    file=sys.stderr, flush=True,
                )
                self._task_post_or_log(
                    api.post_fail, "fail", task_id,
                    execute_base, task_id, bearer, claim_token,
                    f"Provider authentication failed: {auth_code}",
                )
                return

        if exit_code == 0:
            payload = markdown or self._task_empty_result_stub(provider, task_id)
            self._task_post_or_log(
                api.post_complete, "complete", task_id,
                execute_base, task_id, bearer, claim_token, payload,
            )
            return

        if exit_code == 124:
            self._task_post_or_log(
                api.post_timeout, "timeout", task_id,
                execute_base, task_id, bearer, claim_token,
            )
            return

        from hivemoot_agent.plugins_builtin.hivemoot.sanitize import (
            redact_secrets,
        )
        error_text = (result.response or markdown or "").strip()
        if not error_text:
            error_text = f"Task failed with exit code {exit_code}"
        # Scrub known secret patterns from agent-emitted failure text.
        error_text = redact_secrets(error_text)
        self._task_post_or_log(
            api.post_fail, "fail", task_id,
            execute_base, task_id, bearer, claim_token, error_text,
        )

    def _task_best_effort_fail(
        self, job: Job, config: PluginConfig, error_text: str,
    ) -> None:
        """Last-resort failure post when _task_on_job_finished raised."""
        from hivemoot_agent.plugins_builtin.hivemoot.auth import (
            resolve_agent_token,
        )
        from hivemoot_agent.plugins_builtin.hivemoot.tasks import api

        del config  # cfg cached on self

        cfg = self._cfg
        task_id = str(job.metadata.get("task_id") or "")
        claim_token = str(job.metadata.get("claim_token") or "")
        execute_base = cfg.tasks.execute_base_url if cfg else ""
        if not task_id or not claim_token or not execute_base:
            return
        try:
            bearer = resolve_agent_token(
                str(cfg.token_file) if cfg and cfg.token_file else "",
            )
            api.post_fail(
                execute_base, task_id, bearer, claim_token,
                f"Internal error in hivemoot plugin: {error_text}",
            )
        except Exception:
            # Nothing more we can do — at least we logged.
            pass

    @staticmethod
    def _task_post_or_log(
        post_fn, action: str, task_id: str, *args, **kwargs,
    ) -> None:
        if not post_fn(*args, **kwargs):
            print(
                f"[hivemoot-tasks] FAILED to post {action} for task "
                f"{task_id}; dashboard will not see the outcome",
                file=sys.stderr, flush=True,
            )

    def _task_heartbeat_loop(
        self, execute_base: str, task_id: str, token_file: str,
        claim_token: str, interval: int, stop_event: threading.Event,
    ) -> None:
        from hivemoot_agent.plugins_builtin.hivemoot.auth import (
            resolve_agent_token,
        )
        from hivemoot_agent.plugins_builtin.hivemoot.tasks import api

        while not stop_event.wait(interval):
            try:
                # Re-resolve the bearer every tick so token rotation
                # takes effect within one interval rather than
                # waiting for process restart.
                bearer = resolve_agent_token(token_file)
                api.post_heartbeat(execute_base, task_id, bearer, claim_token)
            except Exception as exc:
                print(
                    f"[hivemoot-tasks] heartbeat error for {task_id}: "
                    f"{type(exc).__name__}",
                    file=sys.stderr, flush=True,
                )

    def _resolve_provider_log_path(self, config: PluginConfig) -> str:
        explicit = config.get("AGENT_LAST_RUN_LOG", "")
        if explicit and os.path.isfile(explicit):
            return explicit
        cfg = self._cfg
        workspace = str(cfg.tasks.workspace) if cfg else "/workspace"
        candidate = os.path.join(workspace, "runs", "current", "log")
        return candidate if os.path.isfile(candidate) else ""

    @staticmethod
    def _task_empty_result_stub(provider: str, task_id: str) -> str:
        del task_id
        if provider == "codex":
            return (
                "Task completed, but no agent markdown result could be "
                "extracted from Codex JSON logs."
            )
        if provider in ("gemini", "claude"):
            return (
                f"Task completed, but no output was captured from {provider}."
            )
        return f"Task completed, but no output was captured from {provider}."


def create_plugin() -> Plugin:
    return HivemootPlugin()  # type: ignore[return-value]
