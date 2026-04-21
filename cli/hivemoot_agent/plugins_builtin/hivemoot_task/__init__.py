"""Hivemoot delegated-task plugin.

End-to-end task workflow inside the worker daemon (per ADR-002):

  * Trigger polls hivemoot.dev /api/tasks/claim and dispatches a Job
    when a task is claimed.
  * on_job_started spawns a background heartbeat thread.
  * on_job_finished stops the heartbeat and posts the final outcome
    (complete / fail / timeout), promoting silent codex auth failures
    into reported failures.

A task is a unit of work, not a unit of code edit — the backend can
dispatch anything from "review this RFC" to "summarize yesterday's
governance" to "edit this file."  This plugin deliberately does NOT
couple to the ``github`` plugin: it has no required co-plugins, no
``GITHUB_REPOS`` / ``TARGET_REPO`` reads, and its system prompt is
repo-agnostic.  If a particular task happens to involve a GitHub
repo, the task body carries that context and whichever other plugins
are loaded (github, hivemoot-github, etc.) provide the tools.

The host has no knowledge of any of this — the plugin owns its full
vertical slice.  See docs/adr/002-plugin-architecture.md.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import TYPE_CHECKING

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.hivemoot_task import (
    api,
    auth_errors,
    result_extractor,
)
from hivemoot_agent.plugins_builtin.hivemoot_task.system_prompt import (
    build_system_prompt,
)

if TYPE_CHECKING:
    from hivemoot_agent.plugins_builtin.hivemoot_task.config import (
        HivemootTaskConfig,
    )


def _cfg_of(config: PluginConfig) -> "HivemootTaskConfig | None":
    """Return the typed HivemootTaskConfig, or None if not populated."""
    return config.typed


class HivemootTaskPlugin:
    name = "hivemoot-task"
    version = "0.4.0"
    description = "Hivemoot delegated-task workflow (claim, run, report)"

    def __init__(self) -> None:
        # Per-job heartbeat state — overwritten on each on_job_started so
        # an orphan thread from a slow shutdown can never be revived by
        # the next job (its closure-captured task_id would post for the
        # wrong task otherwise).
        self._heartbeat_stop: threading.Event | None = None
        self._heartbeat_thread: threading.Thread | None = None
        # Codex sidecar path is resolved at job-start time and consumed
        # by on_job_finished for result extraction.  Reset per job.
        self._codex_sidecar_path: str = ""
        # Cached typed config — populated in validate()/setup() so
        # triggers() can decide whether to register without re-reading
        # from the global registry.
        self._cfg: HivemootTaskConfig | None = None

    # ── Validation / setup ─────────────────────────────────────────

    def validate(self, config: PluginConfig) -> list[str]:
        """Config-level validation for the task plugin.

        Intentionally narrow: the plugin does not require any sibling
        plugins or repo configuration.  The only hard requirements are
        the backend wiring (claim_url + execute_base_url + token_file)
        — everything else is the task backend's responsibility to
        route correctly.  A fleet can run a "task-only" agent with
        plugins.hivemoot-task: {} (empty mapping) and no repo cloning
        at all, and the plugin will happily dispatch whatever the
        backend sends.
        """
        from hivemoot_agent.plugins_builtin.hivemoot_task.config import (
            HivemootTaskConfig,
        )

        cfg: HivemootTaskConfig | None = config.typed
        if cfg is None:
            return [
                "hivemoot-task plugin requires typed config (plugins."
                "hivemoot-task in hivemoot.yaml).  Env-var configuration "
                "was removed in 0.4.0."
            ]
        self._cfg = cfg

        errors: list[str] = []

        # Trigger-side validation (claim URL, execute base, auth).
        # Only enforced when the plugin is actually wired up to a
        # backend — empty claim_url implies "no daemon trigger, but
        # we still ship the system prompt for one-shot dispatch".
        if cfg.claim_url or cfg.execute_base_url:
            from hivemoot_agent.plugins_builtin.hivemoot_task.trigger import (
                HivemootTaskTrigger,
            )
            errors.extend(HivemootTaskTrigger(self).validate(config))

        return errors

    def setup(self, config: PluginConfig) -> None:
        # No setup work: tasks are per-job units with no persistent
        # plugin-level state.  If a task happens to need a repo
        # checkout, the github plugin (when loaded) handles that
        # independently; this plugin doesn't care.
        pass

    def triggers(self) -> list[Trigger]:
        # Only register the trigger when a backend is configured.
        # Without it, the plugin still exposes its workload (system
        # prompt, skills) for one-shot runs but no polling happens.
        # validate()/setup() have already cached self._cfg under
        # ADR-003; if neither has run (test harness etc.) bail out
        # with no triggers rather than crash.
        from hivemoot_agent.plugins_builtin.hivemoot_task.trigger import (
            HivemootTaskTrigger,
        )

        cfg = self._cfg
        if cfg is None or not cfg.claim_url:
            return []
        return [HivemootTaskTrigger(self)]  # type: ignore[list-item]

    def system_prompt(self, config: PluginConfig) -> str:
        # Repo-agnostic by design — see module docstring.  The per-task
        # prompt body (rendered by the trigger) carries any specific
        # scope the backend wants the agent to focus on.
        return build_system_prompt()

    # ── Per-job lifecycle ──────────────────────────────────────────

    def on_job_started(self, job: Job, config: PluginConfig) -> None:
        """Post the initial progress ping and start the heartbeat thread.

        Wrapped in try/except so a malformed env var or transient
        backend hiccup never escapes — losing the heartbeat is bad,
        losing the agent run because we couldn't post progress is worse.
        """
        try:
            self._on_job_started_inner(job, config)
        except Exception as exc:
            print(
                f"[hivemoot-task] on_job_started failed for "
                f"{job.metadata.get('task_id')}: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr, flush=True,
            )

    def _on_job_started_inner(self, job: Job, config: PluginConfig) -> None:
        cfg = _cfg_of(config)
        task_id = str(job.metadata.get("task_id") or "")
        claim_token = str(job.metadata.get("claim_token") or "")
        execute_base = cfg.execute_base_url if cfg else ""

        if not task_id or not claim_token or not execute_base:
            # No backend wiring — nothing to heartbeat against.
            self._codex_sidecar_path = ""
            return

        bearer = api.resolve_executor_token(
            str(cfg.token_file) if cfg and cfg.token_file else "",
        )
        interval = cfg.heartbeat_interval_secs if cfg else 45

        # Codex writes its final markdown to a sidecar when invoked
        # with --output-last-message; remember the path so
        # on_job_finished can pick it up, AND export it via
        # CODEX_ANSWER_FILE so providers/codex.py wires the flag.
        # AGENT_PROVIDER is engine-level, not plugin config — read
        # from settings (env) rather than the typed schema.
        provider = config.get("AGENT_PROVIDER", "claude")
        if provider == "codex":
            workspace = str(cfg.workspace) if cfg else "/workspace"
            self._codex_sidecar_path = os.path.join(
                workspace, "task-output", task_id, "codex-answer.md",
            )
            # Pre-create the directory so codex can write the file.
            os.makedirs(
                os.path.dirname(self._codex_sidecar_path), exist_ok=True,
            )
            os.environ["CODEX_ANSWER_FILE"] = self._codex_sidecar_path
        else:
            self._codex_sidecar_path = ""
            os.environ.pop("CODEX_ANSWER_FILE", None)

        # Initial "claimed, starting execution" progress ping mirrors
        # the shell controller's after_worker_start behaviour.
        if not api.post_progress(
            execute_base, task_id, bearer, claim_token,
            f"Task {task_id} claimed. Starting execution.",
        ):
            print(
                f"[hivemoot-task] failed to post initial progress for "
                f"task {task_id}",
                file=sys.stderr, flush=True,
            )

        # interval=0 disables heartbeats (matches the shell's behaviour
        # when AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS<=0).  Skipping the
        # thread entirely also avoids a tight Event.wait(0) busy loop.
        if interval <= 0:
            self._heartbeat_stop = None
            self._heartbeat_thread = None
            return

        # Per-job stop event so an orphaned thread from a slow shutdown
        # cannot post heartbeats for a stale task_id once the next job
        # starts.
        stop_event = threading.Event()
        self._heartbeat_stop = stop_event
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop,
            args=(execute_base, task_id, bearer, claim_token, interval, stop_event),
            daemon=True,
        )
        self._heartbeat_thread.start()

    def on_job_finished(
        self, job: Job, result: AgentResult, config: PluginConfig,
    ) -> None:
        """Stop the heartbeat and post the final outcome.

        Wrapped in try/except so the backend ALWAYS sees an outcome
        even if extraction or auth-error detection raises (the engine
        won't call us again for this job).
        """
        try:
            self._on_job_finished_inner(job, result, config)
        except Exception as exc:
            print(
                f"[hivemoot-task] on_job_finished raised for "
                f"{job.metadata.get('task_id')}: "
                f"{type(exc).__name__}: {exc}; attempting bare fail post",
                file=sys.stderr, flush=True,
            )
            self._best_effort_fail(job, config, str(exc))

    def _on_job_finished_inner(
        self, job: Job, result: AgentResult, config: PluginConfig,
    ) -> None:
        # Stop the heartbeat first so it can't race with the final post.
        # Drop the references immediately so the next job gets a fresh
        # event/thread (no orphan revival via shared event.clear()).
        stop_event = self._heartbeat_stop
        thread = self._heartbeat_thread
        self._heartbeat_stop = None
        self._heartbeat_thread = None
        if stop_event is not None:
            stop_event.set()
        if thread is not None:
            thread.join(timeout=5)

        cfg = _cfg_of(config)
        task_id = str(job.metadata.get("task_id") or "")
        claim_token = str(job.metadata.get("claim_token") or "")
        execute_base = cfg.execute_base_url if cfg else ""

        if not task_id or not claim_token or not execute_base:
            return

        bearer = api.resolve_executor_token(
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
                    f"[hivemoot-task] codex auth error '{auth_code}' "
                    f"detected in task {task_id}; promoting to failure",
                    file=sys.stderr, flush=True,
                )
                self._post_or_log(
                    api.post_fail, "fail", task_id,
                    execute_base, task_id, bearer, claim_token,
                    f"Provider authentication failed: {auth_code}",
                )
                return

        if exit_code == 0:
            payload = markdown or self._empty_result_stub(provider, task_id)
            self._post_or_log(
                api.post_complete, "complete", task_id,
                execute_base, task_id, bearer, claim_token, payload,
            )
            return

        if exit_code == 124:
            self._post_or_log(
                api.post_timeout, "timeout", task_id,
                execute_base, task_id, bearer, claim_token,
            )
            return

        # All other non-zero exits → fail with whatever response/error
        # we have.  The agent's own error text (result.response or a
        # truncated extract) gives the operator something to grep.
        error_text = (result.response or markdown or "").strip()
        if not error_text:
            error_text = f"Task failed with exit code {exit_code}"
        self._post_or_log(
            api.post_fail, "fail", task_id,
            execute_base, task_id, bearer, claim_token, error_text,
        )

    def _best_effort_fail(
        self, job: Job, config: PluginConfig, error_text: str,
    ) -> None:
        """Last-resort failure post when on_job_finished_inner raised."""
        cfg = _cfg_of(config)
        task_id = str(job.metadata.get("task_id") or "")
        claim_token = str(job.metadata.get("claim_token") or "")
        execute_base = cfg.execute_base_url if cfg else ""
        if not task_id or not claim_token or not execute_base:
            return
        try:
            bearer = api.resolve_executor_token(
                str(cfg.token_file) if cfg and cfg.token_file else "",
            )
            api.post_fail(
                execute_base, task_id, bearer, claim_token,
                f"Internal error in hivemoot-task plugin: {error_text}",
            )
        except Exception:
            # Nothing more we can do — at least we logged.
            pass

    @staticmethod
    def _post_or_log(
        post_fn, action: str, task_id: str, *args, **kwargs,
    ) -> None:
        """Call a post_* helper and log a stable line on failure.

        Operators need a signal when the FINAL outcome can't be posted —
        otherwise the dashboard records the task as "running forever"
        with no observable cause.
        """
        if not post_fn(*args, **kwargs):
            print(
                f"[hivemoot-task] FAILED to post {action} for task "
                f"{task_id}; dashboard will not see the outcome",
                file=sys.stderr, flush=True,
            )

    # ── Internal ───────────────────────────────────────────────────

    def _heartbeat_loop(
        self, execute_base: str, task_id: str, bearer: str,
        claim_token: str, interval: int, stop_event: threading.Event,
    ) -> None:
        """Background loop posting heartbeats while the agent runs.

        Takes the stop event explicitly (not from ``self``) so an
        orphaned thread cannot be revived by the next job's
        ``on_job_started`` reassigning ``self._heartbeat_stop``.
        """
        while not stop_event.wait(interval):
            try:
                api.post_heartbeat(execute_base, task_id, bearer, claim_token)
            except Exception as exc:
                # Best-effort: a transient backend hiccup shouldn't
                # kill the agent run.
                print(
                    f"[hivemoot-task] heartbeat error for {task_id}: "
                    f"{type(exc).__name__}",
                    file=sys.stderr, flush=True,
                )

    def _resolve_provider_log_path(self, config: PluginConfig) -> str:
        """Where the engine wrote the agent's NDJSON stream for this run.

        The engine's run_agent uses ``${WORKSPACE_ROOT}/runs/<run-id>/log``
        by convention; the latest run is what we just finished.  When
        the engine config doesn't expose a path, fall back to scanning
        the workspace.  ``AGENT_LAST_RUN_LOG`` is engine-level state
        (set per run) so it stays in env, not the plugin's typed schema.
        """
        explicit = config.get("AGENT_LAST_RUN_LOG", "")
        if explicit and os.path.isfile(explicit):
            return explicit
        # Fall back to the conventional path under the typed workspace.
        cfg = _cfg_of(config)
        workspace = str(cfg.workspace) if cfg else "/workspace"
        candidate = os.path.join(workspace, "runs", "current", "log")
        return candidate if os.path.isfile(candidate) else ""

    @staticmethod
    def _empty_result_stub(provider: str, task_id: str) -> str:
        # task_id deliberately unused — a per-task result.md sidecar is
        # not written by the daemon-mode plugin (the engine streams the
        # provider log straight to the result extractor).
        del task_id  # noqa: F841 — kept in signature for callers
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
    return HivemootTaskPlugin()  # type: ignore[return-value]
