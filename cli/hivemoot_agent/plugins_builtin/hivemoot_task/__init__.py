"""Hivemoot delegated-task plugin.

End-to-end task workflow inside the worker daemon (per ADR-002):

  * Trigger polls hivemoot.dev /api/tasks/claim and dispatches a Job
    when a task is claimed.
  * on_job_started spawns a background heartbeat thread.
  * on_job_finished stops the heartbeat and posts the final outcome
    (complete / fail / timeout), promoting silent codex auth failures
    into reported failures.

The host has no knowledge of any of this — the plugin owns its full
vertical slice.  See docs/adr/002-plugin-architecture.md.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any

from hivemoot_agent.plugins.interfaces import (
    AgentResult,
    Job,
    Plugin,
    PluginConfig,
    Trigger,
)
from hivemoot_agent.plugins_builtin.github.repo_manager import (
    parse_repos,
    repo_checkout_path,
)
from hivemoot_agent.plugins_builtin.hivemoot_task import (
    api,
    auth_errors,
    result_extractor,
)
from hivemoot_agent.plugins_builtin.hivemoot_task.system_prompt import (
    build_system_prompt,
)


def _parse_requested_plugins(raw: str) -> list[str]:
    return [entry.strip() for entry in raw.split(",") if entry.strip()]


def _resolve_target_repo(config: PluginConfig) -> tuple[str, str]:
    target_repo = (config.get("TARGET_REPO", "") or "").strip()
    repos_raw = config.get("GITHUB_REPOS", "") or ""
    try:
        repos = parse_repos(repos_raw)
    except ValueError as exc:
        return "", str(exc)

    if target_repo:
        try:
            parsed_target = parse_repos(target_repo)
        except ValueError as exc:
            return "", str(exc)
        target_repo = parsed_target[0]
        if repos and target_repo not in repos:
            return (
                "",
                "TARGET_REPO must match one of the repositories in GITHUB_REPOS "
                "when hivemoot-task is enabled.",
            )
        return target_repo, ""

    if len(repos) == 1:
        return repos[0], ""
    if not repos:
        return (
            "",
            "hivemoot-task requires GITHUB_REPOS from the github plugin.",
        )
    return (
        "",
        "hivemoot-task requires TARGET_REPO when GITHUB_REPOS contains "
        "multiple repositories.",
    )


def _resolve_workspace_root(config: PluginConfig) -> str:
    return (
        config.get("GITHUB_WORKSPACE", "")
        or config.get("WORKSPACE_ROOT", "/workspace")
        or "/workspace"
    )


def _resolve_repo_path(config: PluginConfig, target_repo: str) -> str:
    workspace = _resolve_workspace_root(config)
    if not target_repo:
        return ""
    return repo_checkout_path(workspace, target_repo)


# Heartbeat cadence: short enough that the backend marks the task as
# alive between polls, long enough to avoid traffic.  Matches the
# shell controller's TASK_HEARTBEAT_INTERVAL_SECONDS default of 45s.
_DEFAULT_HEARTBEAT_INTERVAL_SECS = 45


def _safe_int(value: Any, default: int) -> int:
    """Parse an int from env-derived config, falling back on garbage.

    Operators occasionally pass ``"45s"`` or empty strings; the default
    keeps the agent running with a sensible cadence rather than crashing
    inside ``on_job_started`` (which would lose the claim entirely).
    """
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


class HivemootTaskPlugin:
    name = "hivemoot-task"
    version = "0.3.0"
    description = "Hivemoot delegated-task workflow (claim, run, report)"

    def __init__(self) -> None:
        self._target_repo: str = ""
        self._repo_path: str = ""
        # Per-job heartbeat state — overwritten on each on_job_started so
        # an orphan thread from a slow shutdown can never be revived by
        # the next job (its closure-captured task_id would post for the
        # wrong task otherwise).
        self._heartbeat_stop: threading.Event | None = None
        self._heartbeat_thread: threading.Thread | None = None
        # Codex sidecar path is resolved at job-start time and consumed
        # by on_job_finished for result extraction.  Reset per job.
        self._codex_sidecar_path: str = ""

    # ── Validation / setup ─────────────────────────────────────────

    def validate(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []

        requested = _parse_requested_plugins(config.get("AGENT_PLUGINS", ""))
        if "hivemoot-identity" not in requested:
            errors.append(
                "hivemoot-task requires AGENT_PLUGINS to include hivemoot-identity "
                "so the security guardrails frame every run."
            )
        elif requested.index("hivemoot-identity") > requested.index(self.name):
            errors.append(
                "AGENT_PLUGINS must list hivemoot-identity before hivemoot-task "
                "so the guardrails appear first in the merged system prompt."
            )
        if "github" not in requested:
            errors.append(
                "hivemoot-task requires AGENT_PLUGINS to include github."
            )
        elif requested.index("github") > requested.index(self.name):
            errors.append(
                "AGENT_PLUGINS must list github before hivemoot-task so "
                "repository setup runs first."
            )

        target_repo, target_error = _resolve_target_repo(config)
        if target_error:
            errors.append(target_error)
        elif not target_repo:
            errors.append(
                "hivemoot-task could not determine the target repository."
            )

        # Trigger-side validation (claim URL, execute base, auth).
        # Only enforced when the plugin is actually wired up to a
        # backend — empty config implies "this run is one-shot,
        # not running the daemon trigger".
        if config.get("AGENT_TASK_CLAIM_URL") or config.get(
            "AGENT_TASK_EXECUTE_BASE_URL",
        ):
            from hivemoot_agent.plugins_builtin.hivemoot_task.trigger import (
                HivemootTaskTrigger,
            )
            errors.extend(HivemootTaskTrigger(self).validate(config))

        return errors

    def setup(self, config: PluginConfig) -> None:
        target_repo, error = _resolve_target_repo(config)
        if error:
            raise RuntimeError(error)

        self._target_repo = target_repo
        self._repo_path = _resolve_repo_path(config, target_repo)
        if not self._repo_path or not os.path.isdir(self._repo_path):
            raise RuntimeError(
                "hivemoot-task expected the github plugin to clone "
                f"{target_repo} at {self._repo_path or '(unknown path)'}"
            )

    def triggers(self) -> list[Trigger]:
        # Only register the trigger when a backend is configured.
        # Without it, the plugin still exposes its workload (system
        # prompt, skills) for one-shot runs but no polling happens.
        from hivemoot_agent.plugins_builtin.hivemoot_task.trigger import (
            HivemootTaskTrigger,
        )

        # Read the env directly here (not via config.get) because
        # triggers() is called from the engine before per-job config
        # is materialized.
        if not os.environ.get("AGENT_TASK_CLAIM_URL"):
            return []
        return [HivemootTaskTrigger(self)]  # type: ignore[list-item]

    def system_prompt(self, config: PluginConfig) -> str:
        target_repo = self._target_repo
        if not target_repo:
            target_repo, _ = _resolve_target_repo(config)
        repo_path = self._repo_path or _resolve_repo_path(config, target_repo)
        return build_system_prompt(
            target_repo=target_repo,
            repo_path=repo_path,
        )

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
        task_id = str(job.metadata.get("task_id") or "")
        claim_token = str(job.metadata.get("claim_token") or "")
        execute_base = config.get("AGENT_TASK_EXECUTE_BASE_URL", "")

        if not task_id or not claim_token or not execute_base:
            # No backend wiring — nothing to heartbeat against.
            self._codex_sidecar_path = ""
            return

        bearer = api.resolve_executor_token(
            config.get("HIVEMOOT_AGENT_TOKEN_FILE", ""),
        )
        interval = _safe_int(
            config.get(
                "AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS",
                _DEFAULT_HEARTBEAT_INTERVAL_SECS,
            ),
            _DEFAULT_HEARTBEAT_INTERVAL_SECS,
        )

        # Codex writes its final markdown to a sidecar when invoked
        # with --output-last-message; remember the path so
        # on_job_finished can pick it up, AND export it via
        # CODEX_ANSWER_FILE so providers/codex.py wires the flag.
        provider = config.get("AGENT_PROVIDER", "claude")
        if provider == "codex":
            workspace = _resolve_workspace_root(config)
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

        task_id = str(job.metadata.get("task_id") or "")
        claim_token = str(job.metadata.get("claim_token") or "")
        execute_base = config.get("AGENT_TASK_EXECUTE_BASE_URL", "")

        if not task_id or not claim_token or not execute_base:
            return

        bearer = api.resolve_executor_token(
            config.get("HIVEMOOT_AGENT_TOKEN_FILE", ""),
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
        task_id = str(job.metadata.get("task_id") or "")
        claim_token = str(job.metadata.get("claim_token") or "")
        execute_base = config.get("AGENT_TASK_EXECUTE_BASE_URL", "")
        if not task_id or not claim_token or not execute_base:
            return
        try:
            bearer = api.resolve_executor_token(
                config.get("HIVEMOOT_AGENT_TOKEN_FILE", ""),
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
        the workspace.
        """
        explicit = config.get("AGENT_LAST_RUN_LOG", "")
        if explicit and os.path.isfile(explicit):
            return explicit
        # Fall back to the conventional path under the workspace.
        workspace = _resolve_workspace_root(config)
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
