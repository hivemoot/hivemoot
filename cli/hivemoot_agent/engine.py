"""Engine — the core runtime that runs inside a long-lived container.

Loads plugins, starts triggers, runs the agent with MCP tools, and
fires plugin lifecycle callbacks.  One process, one container.

The agent's stdout is streamed and parsed into AgentEvent objects.
The final response is extracted from stdout for all providers and
delivered by the plugin (e.g., sent to Telegram).
"""

from __future__ import annotations

import json
import os
import shutil
import queue
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from hivemoot_agent.plugins import registry
from hivemoot_agent.plugins.interfaces import AgentEvent, AgentResult, Job, PluginConfig
from hivemoot_agent.providers import get as get_provider
from hivemoot_agent.sessions import (
    SessionStore,
    build_scoped_key,
    create_session_store,
)

_RESUME_STALENESS_NOTE = (
    "You are resuming a prior session. Some data in your context "
    "may be stale; refresh relevant information before acting."
)
_DEFAULT_AGENT_MEMORY_DIR = "/home/node/.hivemoot/memory"
_EXTERNAL_SKILLS_DIR = "/opt/hivemoot-agent/skills"

# Root system prompt lives next to this module so it ships inside the
# runtime image and is always available regardless of deployer config.
_ROOT_SYSTEM_PROMPT_PATH = (
    Path(__file__).resolve().parent / "root_system_prompt.md"
)


@lru_cache(maxsize=1)
def _load_root_system_prompt() -> str:
    """Return the runtime's universal baseline system prompt.

    The root applies to every agent built on this runtime — universal
    rules about security posture, honesty, and reasoning discipline
    that hold regardless of identity or capability composition.  The
    file is bundled with the code so it can't be silently replaced at
    runtime; changes go through image rebuild + review.

    An OSError here means the runtime image is corrupt — the file
    ships IN the package.  Refuse to run rather than silently start
    with empty security guardrails (the old behaviour was a
    direct contradiction of the docstring's own guarantee).
    """
    try:
        return _ROOT_SYSTEM_PROMPT_PATH.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError(
            f"runtime image corrupt: root system prompt at "
            f"{_ROOT_SYSTEM_PROMPT_PATH} is unreadable ({exc}).  "
            "Refusing to start — an agent without root guardrails is "
            "never what the operator intended."
        ) from exc


def _load_identity() -> str:
    """Return the deployer-supplied identity, if any.

    Identity is per-agent content that defines *who* this specific
    agent is — role, voice, mission, domain conventions.  It's brought
    in by the deployer at container-setup time via
    ``AGENT_IDENTITY_FILE``, not baked into this repo.  Unset / missing
    / empty file is valid: the agent runs with just root + plugins, a
    "generic agent" with universal rules but no specific character.

    Read uncached because the file lives outside the runtime image and
    may legitimately change between restarts (operator swap, secret
    rotation).  One read per job is cheap.
    """
    path = (os.environ.get("AGENT_IDENTITY_FILE") or "").strip()
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError as exc:
        print(
            f"[engine] WARN: AGENT_IDENTITY_FILE={path!r} not readable: "
            f"{exc}; running without identity",
            file=sys.stderr, flush=True,
        )
        return ""


@dataclass
class _SkillRuntime:
    """Resolved native skill staging for one provider invocation."""

    prompt_skills: str = ""
    plugin_dir: str = ""
    scope_json: str = "{}"
    staged_links: list[Path] = field(default_factory=list)
    lock_files: list[Path] = field(default_factory=list)
    created_lock_dirs: list[Path] = field(default_factory=list)
    created_dirs: list[Path] = field(default_factory=list)


class Engine:
    """Loads plugins, starts triggers, runs agents with MCP tools."""

    def __init__(self) -> None:
        self._running = True
        self._session_store: SessionStore | None = None
        # All enabled plugins — set by run()/oneshot() so run_agent()
        # can merge system prompts from every plugin, not just the
        # one that triggered the job.
        self._plugins: dict[str, Any] = {}

    def _resolve_plugins(self) -> dict[str, Any] | None:
        """Discover + activate plugins.

        **Activation path** — single source of truth, per ADR-003:
        the ``plugins:`` section of ``hivemoot.yaml``.  The legacy
        ``AGENT_PLUGINS`` env var is no longer consulted; setting it
        emits a warning so deployers notice and migrate.

        Return values:
          * ``{}`` — no config file shipped, or its ``plugins:`` section
            is empty.  Legitimate for bare oneshot invocations (local
            dev, smoke tests) where no plugin wiring is wanted.  Callers
            can iterate the empty dict like any other.
          * ``dict[str, Plugin]`` — activation succeeded.
          * ``None`` — config file exists but is invalid OR a referenced
            plugin type isn't installed OR a plugin's own validate()
            returned errors.  Callers MUST bail; starting with a partial
            plugin set is never safe.

        For each plugin entry:
          1. Look up the installed plugin by ``type_name``.
          2. If its manifest declares a ``schema_class``, validate
             the raw config against the Pydantic schema → typed instance.
          3. Build a PluginConfig that carries both the typed instance
             (for migrated plugins) AND a settings dict containing env
             + raw-config values (for plugins still reading via
             ``config.get()`` — migrated incrementally in later PRs).
          4. Run the plugin's own ``validate()`` hook.
        """
        from hivemoot_agent.config import ConfigLoader, ConfigLoadError

        registry.discover()
        all_plugins = registry.all()

        if os.environ.get("AGENT_PLUGINS", "").strip():
            print(
                "[engine] WARNING: AGENT_PLUGINS env var is deprecated under "
                "ADR-003 and ignored.  Plugin activation lives in the "
                "'plugins:' section of hivemoot.yaml (default path: "
                "/run/agent/hivemoot.yaml; override via AGENT_CONFIG_FILE).",
                file=sys.stderr, flush=True,
            )

        # No config file → no plugins, not an error.  Oneshot / smoke
        # callers use this path for bare agent runs without wiring.
        config_file = Path(
            os.environ.get("AGENT_CONFIG_FILE") or "/run/agent/hivemoot.yaml"
        )
        if not config_file.is_file():
            return {}

        try:
            loaded = ConfigLoader().load()
        except ConfigLoadError as exc:
            print(f"[engine] FATAL: config load: {exc}", file=sys.stderr, flush=True)
            return None

        if not loaded.plugins:
            return {}

        selected: dict[str, Any] = {}
        had_error = False
        for entry in loaded.plugins:
            plugin = all_plugins.get(entry.type_name)
            if plugin is None:
                print(
                    f"[engine] FATAL: config references plugin type "
                    f"'{entry.type_name}' (instance '{entry.instance_name}') "
                    f"which is not installed.  Available types: "
                    f"{', '.join(sorted(all_plugins)) or '(none)'}",
                    file=sys.stderr,
                )
                had_error = True
                continue

            manifest = registry.manifest_for(entry.type_name)
            typed = None
            if manifest is not None and manifest.schema_class is not None:
                try:
                    typed = manifest.validate_config(entry.raw_config)
                except Exception as exc:
                    print(
                        f"[engine] FATAL: plugin '{entry.instance_name}' "
                        f"config invalid:\n  {exc}",
                        file=sys.stderr,
                    )
                    had_error = True
                    continue

            # All built-in plugins now read from .typed; settings carries
            # only engine-level cross-cutting env (AGENT_ID,
            # AGENT_PROVIDER, AGENT_LAST_RUN_LOG, etc.) for the handful
            # of read sites that need it.  No more YAML→settings alias
            # bridging — single source of truth per knob.
            config = PluginConfig(
                name=entry.instance_name,
                settings=dict(os.environ),
                typed=typed,
            )

            # Validate BEFORE registering.  If a plugin's validate
            # fails and we've already called registry.configure(), any
            # downstream plugin's validate (e.g. hivemoot-github
            # reading registry.config_for("github")) sees a
            # partially-validated sibling config and may emit a
            # misleading second error.  Registering only after the
            # plugin passes its own checks keeps the registry's
            # contents honest: "configured" means "validated and
            # ready to use."
            errors = plugin.validate(config)
            if errors:
                print(
                    f"[engine] FATAL: plugin '{entry.instance_name}' "
                    "validation failed:",
                    file=sys.stderr,
                )
                for err in errors:
                    print(f"  - {err}", file=sys.stderr)
                had_error = True
                continue

            registry.configure(entry.instance_name, config)
            selected[entry.instance_name] = plugin

        if had_error:
            return None
        return selected

    def _setup_plugins(self, plugins: dict[str, Any]) -> bool:
        """Run one-time plugin setup and fail closed on errors."""
        for name, plugin in plugins.items():
            config = registry.config_for(name)
            try:
                plugin.setup(config)
            except Exception as exc:
                print(
                    f"[engine] FATAL: plugin '{name}' setup failed: {exc}",
                    file=sys.stderr, flush=True,
                )
                return False
        return True

    def _init_session_store(self, config: PluginConfig) -> None:
        """Lazy-init the persistent session store from config/env."""
        if self._session_store is not None:
            return
        self._session_store = create_session_store(config)
        reset_info = (
            f", reset_at_hour={self._session_store.reset_at_hour}"
            if self._session_store.reset_at_hour is not None
            else ""
        )
        print(
            f"[engine] session store: {self._session_store.map_file} "
            f"(resume={'on' if self._session_store.resume_enabled else 'off'}"
            f", idle={self._session_store.max_idle_hours}h"
            f", age={self._session_store.max_age_hours}h"
            f"{reset_info})",
            file=sys.stderr, flush=True,
        )

    def run(self) -> int:
        """Main entry point.  Blocks until shutdown."""
        _load_file_secrets()
        enabled = self._resolve_plugins()

        if enabled is None:
            # Fatal config error (already logged by _resolve_plugins).
            # Exit non-zero so systemd / docker --restart see the failure
            # and the operator isn't fooled by a "healthy" container
            # idling with no plugins.  The prior sleep-forever behaviour
            # hid real deploy regressions for as long as the container
            # ran.
            print(
                "[engine] fatal config error, no plugins activated; exiting 1",
                file=sys.stderr, flush=True,
            )
            return 1

        if not enabled:
            # No config file OR an empty ``plugins:`` section.
            # Still a misconfiguration in daemon mode (nothing to
            # trigger), but distinguish it from the fatal case so the
            # operator log can tell them apart.  Non-zero exit either
            # way — a daemon container with zero triggers is never
            # what the operator intended.
            print(
                "[engine] no plugins configured (missing or empty "
                "plugins: section in hivemoot.yaml); exiting 1",
                file=sys.stderr, flush=True,
            )
            return 1

        self._plugins = enabled

        # One-time plugin setup (clone repos, authenticate, etc.).
        if not self._setup_plugins(enabled):
            return 1

        # Initialize persistent session store.
        first_config = registry.config_for(next(iter(enabled)))
        self._init_session_store(first_config)

        # Start triggers in background threads.
        threads: list[threading.Thread] = []
        triggers: list[Any] = []

        for name, plugin in enabled.items():
            config = registry.config_for(name)
            for trigger in plugin.triggers():
                dispatcher = _PluginDispatcher(self, plugin, config, name)
                t = threading.Thread(
                    target=self._run_trigger,
                    args=(trigger, config, dispatcher, name),
                    daemon=True,
                )
                t.start()
                threads.append(t)
                triggers.append(trigger)
                print(
                    f"[engine] trigger '{trigger.name}' started "
                    f"(plugin={name})",
                    file=sys.stderr,
                )

        if not threads:
            print("No triggers to run.", file=sys.stderr)
            return 1

        print(
            f"[engine] running with {len(threads)} trigger(s)",
            file=sys.stderr,
        )

        try:
            while self._running:
                alive = any(t.is_alive() for t in threads)
                if not alive:
                    break
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n[engine] shutting down...", file=sys.stderr)

        self._running = False
        for trigger in triggers:
            trigger.stop()
        for t in threads:
            t.join(timeout=5)

        return 0

    def oneshot(
        self,
        prompt: str | None = None,
    ) -> int:
        """Run the agent once and exit.

        If ``hivemoot.yaml`` (or ``AGENT_CONFIG_FILE``) exists, loads
        the plugins it declares, runs their setup hooks (clone repos,
        authenticate, etc.), and merges their system prompts.  Without
        a config file, runs a plain agent with no plugin support — the
        bare oneshot path for local testing.
        """
        _load_file_secrets()

        if not prompt:
            prompt = os.environ.get("AGENT_EXTRA_PROMPT", "")
        if not prompt:
            prompt_file = os.environ.get("AGENT_EXTRA_PROMPT_FILE", "")
            if prompt_file and os.path.isfile(prompt_file):
                with open(prompt_file) as f:
                    prompt = f.read().strip()
        if not prompt:
            prompt = "Make meaningful contributions to the repository."

        config = PluginConfig(name="oneshot", settings=dict(os.environ))
        provider_name = config.get("AGENT_PROVIDER", "claude")
        provider = get_provider(provider_name)
        model = config.get("AGENT_MODEL", "") or ""
        explicit_session_key = os.environ.get("AGENT_SESSION_KEY", "").strip()

        # Plugins load from hivemoot.yaml — no env gate.
        # ``_resolve_plugins`` returns ``{}`` when no config file is
        # shipped (valid for bare oneshot runs) and ``None`` only on a
        # genuine config error; we only bail on the latter.
        plugins = self._resolve_plugins()
        if plugins is None:
            return 1

        # One-time plugin setup (clone repos, authenticate, etc.).
        job = Job(session_key=explicit_session_key or "oneshot", prompt=prompt)
        if plugins:
            self._plugins = plugins
            if not self._setup_plugins(plugins):
                return 1

        # Build system prompt — after setup() so plugins have real
        # state (cloned repos, resolved branches, etc.).
        if plugins:
            system_prompt = self._build_system_prompt()
        else:
            system_prompt = (
                "You are an autonomous AI agent. Complete the task described "
                "in the user message. Be thorough and systematic."
            )
        oneshot_repo = (
            config.get("TARGET_REPO", "")
            or config.get("GITHUB_REPOS", "")
            or ""
        )
        system_prompt = _append_agent_memory(system_prompt, repo=oneshot_repo)
        try:
            skill_runtime = self._resolve_skill_runtime(config, provider)
        except ValueError as exc:
            print(f"[engine] FATAL: {exc}", file=sys.stderr, flush=True)
            return 1
        if skill_runtime.prompt_skills:
            system_prompt = f"{system_prompt}\n\n{skill_runtime.prompt_skills}"

        scoped_key = ""
        prior_record = None
        session_id = ""
        is_resume = False
        if explicit_session_key:
            self._init_session_store(config)
            scoped_key = build_scoped_key(
                base_key=explicit_session_key,
                provider=provider_name,
                model=model,
                repo=oneshot_repo,
                tool_options_json=config.get("AGENT_TOOL_OPTIONS_JSON", "") or "",
                skill_options_json=skill_runtime.scope_json,
            )
            if scoped_key and self._session_store:
                session_id, prior_record = self._session_store.lookup(scoped_key)
                is_resume = bool(session_id)

        effective_prompt = prompt
        if is_resume:
            effective_prompt = f"{prompt}\n\n{_RESUME_STALENESS_NOTE}"

        # Plugin lifecycle parity with run_agent: every plugin gets a
        # chance to set per-job env (e.g. CODEX_ANSWER_FILE) BEFORE the
        # provider command is built, and on_job_finished is guaranteed
        # to fire even if the body raises.  ``plugins`` is None for the
        # bare-oneshot path (no hivemoot.yaml present); skip both
        # lifecycle arms in that case.
        if plugins:
            for name, plugin in plugins.items():
                if not hasattr(plugin, "on_job_started"):
                    continue
                plugin_config = registry.config_for(name)
                try:
                    plugin.on_job_started(job, plugin_config)
                except Exception as exc:
                    print(
                        f"[engine] {name}.on_job_started raised: "
                        f"{type(exc).__name__}: {exc}",
                        file=sys.stderr, flush=True,
                    )

        result = AgentResult(exit_code=1, response="")
        try:
            cmd = self._build_provider_cmd(
                provider, provider_name, effective_prompt, system_prompt,
                model, "", session_id, plugin_dir=skill_runtime.plugin_dir,
            )

            plugin_label = ", ".join(plugins) if plugins else "none"
            resume_label = f", resume={session_id[:12]}..." if is_resume else ""
            print(
                f"[engine] oneshot: provider={provider_name} "
                f"plugins={plugin_label} prompt={len(prompt)} chars{resume_label}",
                file=sys.stderr, flush=True,
            )

            exit_code, stdout = self._run_oneshot_subprocess(cmd, config)
            if is_resume and exit_code != 0:
                print(
                    "[engine] session resume failed; retrying oneshot with fresh session",
                    file=sys.stderr, flush=True,
                )
                is_resume = False
                prior_record = None
                cmd = self._build_provider_cmd(
                    provider, provider_name, prompt, system_prompt,
                    model, "", "", plugin_dir=skill_runtime.plugin_dir,
                )
                exit_code, stdout = self._run_oneshot_subprocess(cmd, config)

            try:
                self._cleanup_skill_runtime(skill_runtime)
            except Exception:
                pass

            # Print the agent's response to stdout so callers can capture it.
            response = ""
            if exit_code == 0 and stdout:
                try:
                    new_session = (
                        provider.extract_session_id(stdout) if provider else ""
                    )
                except Exception:
                    new_session = ""
                if new_session and scoped_key and self._session_store:
                    try:
                        self._session_store.save(
                            scoped_key, new_session,
                            was_resume=is_resume,
                            prior_record=prior_record,
                        )
                        print(
                            f"[engine] session saved: {job.session_key} → "
                            f"{new_session[:12]}...",
                            file=sys.stderr, flush=True,
                        )
                    except Exception as exc:
                        print(
                            f"[engine] session save failed: "
                            f"{type(exc).__name__}: {exc}",
                            file=sys.stderr, flush=True,
                        )
                try:
                    response = _extract_response(stdout)
                except Exception:
                    response = ""
                if response:
                    print(response, flush=True)

            result = AgentResult(exit_code=exit_code, response=response)
            return exit_code
        finally:
            # Run plugin teardown hooks.  Mirror run_agent: persist the
            # raw stdout (or clear stale path) before calling
            # on_job_finished so plugins consume only this job's log.
            if plugins:
                stdout_for_log = locals().get("stdout", "")
                log_path = self._persist_run_log(config, job, stdout_for_log)
                if log_path:
                    os.environ["AGENT_LAST_RUN_LOG"] = log_path
                    config.settings["AGENT_LAST_RUN_LOG"] = log_path
                else:
                    os.environ.pop("AGENT_LAST_RUN_LOG", None)
                    config.settings.pop("AGENT_LAST_RUN_LOG", None)
                for name, plugin in plugins.items():
                    plugin_config = registry.config_for(name)
                    if log_path:
                        plugin_config.settings["AGENT_LAST_RUN_LOG"] = log_path
                    else:
                        plugin_config.settings.pop("AGENT_LAST_RUN_LOG", None)
                    try:
                        plugin.on_job_finished(job, result, plugin_config)
                    except Exception as exc:
                        print(
                            f"[engine] {name}.on_job_finished raised: "
                            f"{type(exc).__name__}: {exc}",
                            file=sys.stderr, flush=True,
                        )

    @staticmethod
    def _run_oneshot_subprocess(
        cmd: list[str],
        config: PluginConfig,
    ) -> tuple[int, str]:
        """Run a oneshot subprocess and return (exit_code, stdout)."""
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=int(config.get("AGENT_TIMEOUT_SECONDS", "1800")),
            )
            exit_code = proc.returncode
            stdout = proc.stdout
            print(
                f"[engine] oneshot exit={exit_code}",
                file=sys.stderr, flush=True,
            )
            if proc.stderr:
                print(proc.stderr[:500], file=sys.stderr, flush=True)
            return exit_code, stdout
        except subprocess.TimeoutExpired:
            print("[engine] oneshot timed out", file=sys.stderr, flush=True)
            return 124, ""
        except Exception as exc:
            print(f"[engine] oneshot failed: {exc}", file=sys.stderr, flush=True)
            return 1, ""

    def _run_trigger(
        self,
        trigger: Any,
        config: PluginConfig,
        dispatcher: Any,
        plugin_name: str,
    ) -> None:
        """Run a trigger with restart-on-failure."""
        backoff = 5
        max_backoff = 300

        while self._running:
            try:
                trigger.start(config, dispatcher)
            except Exception as exc:
                if not self._running:
                    break
                print(
                    f"[engine] trigger '{trigger.name}' failed: {exc}",
                    file=sys.stderr,
                )

            if not self._running:
                break

            print(
                f"[engine] trigger '{trigger.name}' restarting "
                f"in {backoff}s",
                file=sys.stderr,
            )
            time.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)

    def _build_system_prompt(self) -> str:
        """Assemble the three-layer system prompt: root + identity + plugins.

        Layers, in order:
          * ``<root>`` — runtime baseline from ``root_system_prompt.md``.
            Always present.  Security, honesty, reasoning discipline.
            The ``@lru_cache`` keeps this to one disk read per process.
          * ``<identity>`` — deployer-supplied from ``AGENT_IDENTITY_FILE``.
            Optional.  Who this specific agent is: role, voice, mission.
          * ``<plugin name="...">`` — one per enabled plugin, in
            ``AGENT_PLUGINS`` order.  Capability-level content only.

        The distinct tag names matter: the model can reason about which
        layer a rule came from, and identity content can't accidentally
        override root rules by appearing earlier in a merge.
        """
        parts: list[str] = []

        root = _load_root_system_prompt()
        if root:
            parts.append(f"<root>\n{root}\n</root>")

        identity = _load_identity()
        if identity:
            parts.append(f"<identity>\n{identity}\n</identity>")

        for name, p in self._plugins.items():
            p_config = registry.config_for(name)
            sp = p.system_prompt(p_config)
            if sp:
                parts.append(
                    f"<plugin name=\"{name}\" version=\"{p.version}\">\n"
                    f"{sp}\n"
                    f"</plugin>"
                )

        if not parts:
            return ""

        header = (
            "The sections below frame every action you take.\n"
            "<root> is this runtime's non-negotiable baseline. "
            "<identity>, when present, is the specific agent you are "
            "(supplied by the deployer). Each <plugin> block is a "
            "capability available to you. When layers conflict, <root> "
            "wins, then <identity>, then plugins."
        )
        return header + "\n\n" + "\n\n".join(parts)

    def _resolve_skill_search_dirs(self) -> list[Path]:
        """Resolve external and plugin-provided skill search roots."""
        paths = [Path(_EXTERNAL_SKILLS_DIR)]
        for _name, plugin in self._plugins.items():
            skills_dir = self._resolve_plugin_skills_dir(plugin)
            if skills_dir:
                paths.append(Path(skills_dir))

        seen: set[Path] = set()
        result: list[Path] = []
        for path in paths:
            if path in seen:
                continue
            seen.add(path)
            result.append(path)
        return result

    def _build_skills_plugin_dir(self, skills: list[Any] | None = None) -> str:
        """Generate a Claude plugin dir from explicit or discovered skills."""
        from hivemoot_agent.plugins.skills import (
            collect_skills_from_dirs,
            generate_plugin_dir,
        )

        if skills is None:
            skills = list(
                collect_skills_from_dirs(
                    self._resolve_skill_search_dirs(),
                ).values()
            )
        if not skills:
            return ""

        result = generate_plugin_dir(skills)
        print(
            f"[engine] skills plugin-dir: {len(skills)} skill(s) "
            f"({', '.join(skill.name for skill in skills)})",
            file=sys.stderr, flush=True,
        )
        return result

    @staticmethod
    def _build_skill_scope_json(
        skills: list[Any],
        backend: str,
    ) -> str:
        """Encode the effective skill set for session scoping.

        Single ``skills`` list, plugin-driven — see _resolve_skill_runtime.
        Used only for session-key derivation; if the active plugin set
        changes between runs, the scope_json shifts and the session
        forks rather than mixing skill states.
        """
        return json.dumps(
            {
                "backend": backend,
                "skills": [skill.name for skill in skills],
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    def _stage_workspace_agents_skills(self, skills: list[Any]) -> _SkillRuntime:
        """Expose selected skills through the workspace `.agents/skills` tier."""
        if not skills:
            return _SkillRuntime()

        workspace_root = Path.cwd()
        agents_root = workspace_root / ".agents"
        skills_root = agents_root / "skills"
        locks_root = agents_root / ".hivemoot-skill-locks"

        planned_links: list[tuple[Path, Path]] = []
        skill_sources: list[tuple[str, Path]] = []
        for skill in skills:
            source_dir = Path(skill.source_dir)
            if not source_dir.is_dir():
                raise ValueError(
                    f"Skill source directory missing for native load: {skill.name}"
                )

            resolved_source = source_dir.resolve()
            link_path = skills_root / skill.name
            if link_path.exists() or link_path.is_symlink():
                if not link_path.is_symlink():
                    raise ValueError(
                        f"workspace skill collision at {link_path} for {skill.name}"
                    )
                try:
                    existing_target = link_path.resolve(strict=True)
                except FileNotFoundError as exc:
                    raise ValueError(
                        f"workspace skill collision at {link_path} for {skill.name}"
                    ) from exc
                if existing_target != resolved_source:
                    raise ValueError(
                        f"workspace skill collision at {link_path} for {skill.name}"
                    )
            else:
                planned_links.append((link_path, resolved_source))

            skill_sources.append((skill.name, resolved_source))

        runtime = _SkillRuntime()
        created_dirs: list[Path] = []
        for path in (agents_root, skills_root, locks_root):
            if path.exists():
                continue
            path.mkdir(parents=True, exist_ok=True)
            created_dirs.append(path)
        runtime.created_dirs = created_dirs
        run_id = f"{os.getpid()}-{time.time_ns()}"

        try:
            for link_path, source_dir in planned_links:
                os.symlink(str(source_dir), str(link_path), target_is_directory=True)
                runtime.staged_links.append(link_path)

            for skill_name, _source_dir in skill_sources:
                lock_dir = locks_root / skill_name
                if not lock_dir.exists():
                    lock_dir.mkdir(parents=True, exist_ok=True)
                    runtime.created_lock_dirs.append(lock_dir)

                lock_file = lock_dir / run_id
                lock_file.write_text("")
                runtime.lock_files.append(lock_file)
        except Exception:
            self._cleanup_skill_runtime(runtime)
            raise

        print(
            f"[engine] workspace skills: {len(skills)} skill(s) "
            f"({', '.join(skill.name for skill in skills)})",
            file=sys.stderr, flush=True,
        )
        return runtime

    def _resolve_skill_runtime(
        self,
        config: PluginConfig,
        provider: Any,
    ) -> _SkillRuntime:
        """Resolve skill delivery for the current provider.

        Plugin-owned model: every skill bundled in an active plugin's
        ``skills/`` subdir (or the legacy ``/opt/hivemoot-agent/skills``
        external mount) is auto-loaded and exposed to the agent.  No
        per-agent env-var indirection — plugin activation IS skill
        exposure.

        The legacy ``AGENT_SKILLS`` and ``AGENT_AVAILABLE_SKILLS`` env
        vars are deprecated.  If a deployer still sets them, log a
        one-line warning explaining they're ignored so the operator
        notices and removes the dead config rather than wondering
        why nothing changes.
        """
        from hivemoot_agent.plugins.skills import (
            collect_skills_from_dirs,
            render_prompt_skills,
        )

        for legacy_var in ("AGENT_SKILLS", "AGENT_AVAILABLE_SKILLS"):
            if (config.get(legacy_var, "") or "").strip():
                print(
                    f"[engine] DEPRECATED: {legacy_var} is ignored.  All "
                    f"skills bundled with active plugins are auto-loaded; "
                    f"drop {legacy_var} from your env.",
                    file=sys.stderr, flush=True,
                )

        all_skills = list(
            collect_skills_from_dirs(
                self._resolve_skill_search_dirs(),
            ).values()
        )

        backend = getattr(provider, "native_skill_backend", "")
        scope_json = self._build_skill_scope_json(all_skills, backend)

        if backend == "claude_plugin_dir":
            if not all_skills:
                return _SkillRuntime(scope_json=scope_json)
            return _SkillRuntime(
                plugin_dir=self._build_skills_plugin_dir(all_skills),
                scope_json=scope_json,
            )

        if backend == "workspace_agents_dir":
            runtime = self._stage_workspace_agents_skills(all_skills)
            runtime.scope_json = scope_json
            return runtime

        # Prompt-injection providers (codex, gemini, opencode, kilo):
        # the entire skill set goes into the system prompt as the
        # <skills> block.  No selected/available distinction at this
        # layer — providers without a native skill backend get the
        # full pool every turn.
        if not all_skills:
            return _SkillRuntime(scope_json=scope_json)
        return _SkillRuntime(
            prompt_skills=render_prompt_skills(all_skills),
            scope_json=scope_json,
        )

    @staticmethod
    def _cleanup_skill_runtime(runtime: _SkillRuntime) -> None:
        """Remove ephemeral native skill staging created for this run."""
        if runtime.plugin_dir and os.path.isdir(runtime.plugin_dir):
            shutil.rmtree(runtime.plugin_dir, ignore_errors=True)

        for lock_file in runtime.lock_files:
            try:
                lock_file.unlink()
            except OSError:
                pass

        for link_path in runtime.staged_links:
            try:
                link_path.unlink()
            except OSError:
                pass

        for lock_dir in runtime.created_lock_dirs:
            try:
                if list(lock_dir.iterdir()):
                    continue
                lock_dir.rmdir()
            except OSError:
                pass

        for path in sorted(runtime.created_dirs, key=lambda item: len(str(item)), reverse=True):
            try:
                path.rmdir()
            except OSError:
                pass

    @staticmethod
    def _resolve_plugin_skills_dir(plugin: Any) -> str:
        """Resolve the on-disk ``skills/`` directory for a plugin instance.

        Plugins discovered by the built-in registry carry an explicit
        ``__hivemoot_plugin_root__`` hint. For manually registered plugins,
        fall back to scanning the loaded module/package chain so classes
        defined in nested modules still resolve skills from the package root.
        """
        import inspect
        from pathlib import Path

        root_hint = getattr(plugin, "__hivemoot_plugin_root__", "")
        if root_hint:
            skills_dir = Path(root_hint) / "skills"
            return str(skills_dir) if skills_dir.is_dir() else ""

        module_parts = type(plugin).__module__.split(".")
        seen: set[Path] = set()
        for idx in range(len(module_parts), 0, -1):
            module_name = ".".join(module_parts[:idx])
            module = sys.modules.get(module_name)
            module_file = getattr(module, "__file__", "") if module else ""
            if not module_file:
                continue
            candidate_dir = Path(module_file).parent
            if candidate_dir in seen:
                continue
            seen.add(candidate_dir)
            skills_dir = candidate_dir / "skills"
            if skills_dir.is_dir():
                return str(skills_dir)

        try:
            candidate_dir = Path(inspect.getfile(type(plugin))).parent
        except (TypeError, OSError):
            return ""
        skills_dir = candidate_dir / "skills"
        return str(skills_dir) if skills_dir.is_dir() else ""

    def run_agent(
        self,
        plugin: Any,
        job: Job,
        config: PluginConfig,
        plugin_name: str,
    ) -> AgentResult:
        """Run the agent with MCP tools from the plugin."""
        job_repo = config.get("GITHUB_REPOS", "") or ""
        system_prompt = _append_agent_memory(self._build_system_prompt(), repo=job_repo)
        provider_name = config.get("AGENT_PROVIDER", "claude")
        provider = get_provider(provider_name)
        model = config.get("AGENT_MODEL", "") or ""
        skill_runtime = self._resolve_skill_runtime(config, provider)
        if skill_runtime.prompt_skills:
            system_prompt = f"{system_prompt}\n\n{skill_runtime.prompt_skills}"

        # Build MCP config so the agent can call plugin tools.
        mcp_config = self._build_mcp_config(plugin_name, job, config)

        # Session lookup — check persistent store with resume policy.
        self._init_session_store(config)
        scoped_key = build_scoped_key(
            base_key=job.session_key,
            provider=provider_name,
            model=model,
            repo=config.get("GITHUB_REPOS", "") or "",
            tool_options_json=config.get("AGENT_TOOL_OPTIONS_JSON", "") or "",
            skill_options_json=skill_runtime.scope_json,
        )
        session_id = ""
        prior_record = None
        is_resume = False
        if scoped_key and self._session_store:
            session_id, prior_record = self._session_store.lookup(scoped_key)
            is_resume = bool(session_id)

        # When resuming, warn the agent about potential staleness.
        effective_prompt = job.prompt
        if is_resume:
            effective_prompt = f"{job.prompt}\n\n{_RESUME_STALENESS_NOTE}"

        # Plugin gets first crack at per-job env *before* the provider
        # command is built — codex/build_cmd reads CODEX_ANSWER_FILE
        # at build time, and the hivemoot-task plugin sets it from
        # on_job_started.  Reordering here is a contract: by the time
        # any provider builder runs, the plugin has already configured
        # per-job state.
        plugin.on_job_started(job, config)

        # Anything between on_job_started and on_job_finished MUST run
        # on_job_finished too — for hivemoot-task that's where the
        # heartbeat thread is stopped and the terminal outcome posted
        # to the backend.  Without try/finally an exception inside
        # _build_provider_cmd / _run_subprocess / session save / etc.
        # would orphan the heartbeat thread and leave the task stuck
        # in 'running' on the backend forever.
        result = AgentResult(exit_code=1, response="")
        try:
            cmd = self._build_provider_cmd(
                provider, provider_name, effective_prompt, system_prompt,
                model, mcp_config, session_id,
                plugin_dir=skill_runtime.plugin_dir,
            )

            # Build event callback for streaming progress.
            on_event: Callable[[AgentEvent], None] | None = None
            if hasattr(plugin, "on_agent_output"):
                def on_event(event: AgentEvent) -> None:
                    plugin.on_agent_output(job, event, config)

            resume_label = f", resume={session_id[:12]}..." if is_resume else ""
            print(
                f"[engine] running agent (plugin={plugin_name}, "
                f"provider={provider_name}, "
                f"mcp={'yes' if mcp_config else 'no'}{resume_label})",
                file=sys.stderr, flush=True,
            )

            exit_code, stdout = self._run_subprocess(
                cmd, config, on_event=on_event, provider=provider,
            )

            # Retry once with a fresh session if resume failed.
            if is_resume and exit_code != 0:
                print(
                    "[engine] session resume failed; retrying with fresh session",
                    file=sys.stderr, flush=True,
                )
                is_resume = False
                prior_record = None
                cmd = self._build_provider_cmd(
                    provider, provider_name, job.prompt, system_prompt,
                    model, mcp_config, "",
                    plugin_dir=skill_runtime.plugin_dir,
                )
                exit_code, stdout = self._run_subprocess(
                    cmd, config, on_event=on_event, provider=provider,
                )

            # Clean up MCP config and skill staging.  Wrapped because
            # tmp/file races here would otherwise skip the lifecycle
            # teardown below.
            try:
                if mcp_config and os.path.isfile(mcp_config):
                    os.unlink(mcp_config)
            except OSError:
                pass
            try:
                self._cleanup_skill_runtime(skill_runtime)
            except Exception:
                pass

            # Persist session on success.
            if exit_code == 0 and stdout and provider:
                try:
                    new_session = provider.extract_session_id(stdout)
                except Exception:
                    new_session = ""
                if new_session and scoped_key and self._session_store:
                    try:
                        self._session_store.save(
                            scoped_key, new_session,
                            was_resume=is_resume,
                            prior_record=prior_record,
                        )
                        print(
                            f"[engine] session saved: {job.session_key} → "
                            f"{new_session[:12]}...",
                            file=sys.stderr, flush=True,
                        )
                    except Exception as exc:
                        print(
                            f"[engine] session save failed: "
                            f"{type(exc).__name__}: {exc}",
                            file=sys.stderr, flush=True,
                        )

            try:
                response = _extract_response(stdout) if stdout else ""
            except Exception:
                response = ""

            # Persist the provider's raw NDJSON stream so plugins can
            # extract per-provider artifacts (final markdown, token
            # usage, auth-error promotion) post-hoc without parsing
            # stdout in memory.  Path is exposed via AGENT_LAST_RUN_LOG
            # so plugins don't need to know the engine's run-directory
            # layout.  Always either set a fresh path or clear the
            # stale one — never let the previous job's log leak into
            # this job's on_job_finished via the long-lived
            # _PluginDispatcher config.
            log_path = self._persist_run_log(config, job, stdout)
            if log_path:
                os.environ["AGENT_LAST_RUN_LOG"] = log_path
                config.settings["AGENT_LAST_RUN_LOG"] = log_path
            else:
                os.environ.pop("AGENT_LAST_RUN_LOG", None)
                config.settings.pop("AGENT_LAST_RUN_LOG", None)

            result = AgentResult(exit_code=exit_code, response=response)
            return result
        finally:
            # Final outcome MUST be reported.  on_job_finished is
            # already wrapped in try/except inside the hivemoot-task
            # plugin, but the engine still guards against an unhandled
            # raise from any other plugin so a bad lifecycle hook
            # doesn't poison the dispatcher's exception path.
            try:
                plugin.on_job_finished(job, result, config)
            except Exception as exc:
                print(
                    f"[engine] on_job_finished raised: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr, flush=True,
                )

    def _persist_run_log(
        self, config: PluginConfig, job: Job, stdout: str,
    ) -> str:
        """Write the agent's raw stdout to a per-job file; return path.

        Lives under ``${WORKSPACE_ROOT}/runs/<safe-session-key>/log``.
        Returns "" when nothing was captured (caller skips env wire).
        """
        if not stdout:
            return ""
        workspace = (
            config.get("WORKSPACE_ROOT", "")
            or os.environ.get("WORKSPACE_ROOT", "")
            or "/workspace"
        )
        safe_key = "".join(
            c if c.isalnum() or c in "._-" else "_"
            for c in (job.session_key or "oneshot")
        )
        run_dir = os.path.join(workspace, "runs", safe_key)
        try:
            os.makedirs(run_dir, exist_ok=True)
        except OSError:
            return ""
        log_path = os.path.join(run_dir, "log")
        try:
            with open(log_path, "w") as f:
                f.write(stdout)
        except OSError:
            return ""
        return log_path

    def _run_subprocess(
        self,
        cmd: list[str],
        config: PluginConfig,
        on_event: Callable[[AgentEvent], None] | None = None,
        provider: Any = None,
    ) -> tuple[int, str]:
        """Run an agent subprocess with streaming, returning (exit_code, stdout).

        Reads stdout line-by-line in a background thread.  Each line is
        passed to provider.parse_event(); if that returns an AgentEvent
        and on_event is set, the callback is invoked.  Stderr is
        collected in a separate thread to prevent pipe buffer deadlock.
        """
        timeout = int(config.get("AGENT_TIMEOUT_SECONDS", "1800"))

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except Exception as exc:
            print(f"[engine] agent failed: {exc}", file=sys.stderr, flush=True)
            return (1, "")

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        event_queue: queue.Queue[Any] | None = None
        event_sentinel = object()
        event_thread: threading.Thread | None = None

        if on_event is not None:
            event_queue = queue.Queue()

            def _dispatch_events() -> None:
                assert event_queue is not None
                while True:
                    event = event_queue.get()
                    try:
                        if event is event_sentinel:
                            return
                        on_event(event)
                    except Exception as exc:
                        print(
                            f"[engine] event parse/dispatch error: {exc}",
                            file=sys.stderr, flush=True,
                        )
                    finally:
                        event_queue.task_done()

            event_thread = threading.Thread(target=_dispatch_events, daemon=True)
            event_thread.start()

        def _read_stdout() -> None:
            assert proc.stdout is not None
            for line in proc.stdout:
                stdout_lines.append(line)
                if provider is not None and event_queue is not None:
                    try:
                        event = provider.parse_event(line)
                        if event is not None:
                            event_queue.put(event)
                    except Exception as exc:
                        print(
                            f"[engine] event parse/dispatch error: {exc}",
                            file=sys.stderr, flush=True,
                        )

        def _read_stderr() -> None:
            assert proc.stderr is not None
            for line in proc.stderr:
                stderr_lines.append(line)

        t_out = threading.Thread(target=_read_stdout, daemon=True)
        t_err = threading.Thread(target=_read_stderr, daemon=True)
        t_out.start()
        t_err.start()

        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            print("[engine] agent timed out", file=sys.stderr, flush=True)
            proc.kill()
            proc.wait()
            t_out.join()
            t_err.join()
            if event_queue is not None:
                event_queue.put(event_sentinel)
            if event_thread is not None:
                event_thread.join()
            return (124, "")

        t_out.join()
        t_err.join()
        if event_queue is not None:
            event_queue.put(event_sentinel)
        if event_thread is not None:
            event_thread.join()

        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines)

        print(
            f"[engine] agent exit={proc.returncode} "
            f"stdout={len(stdout)} stderr={len(stderr)}",
            file=sys.stderr, flush=True,
        )
        if stderr:
            print(
                f"[engine] stderr: {stderr[:500]}",
                file=sys.stderr, flush=True,
            )
        return (proc.returncode, stdout)

    @staticmethod
    def _build_provider_cmd(
        provider: Any,
        provider_name: str,
        prompt: str,
        system_prompt: str,
        model: str,
        mcp_config: str,
        session_id: str,
        *,
        plugin_dir: str = "",
    ) -> list[str]:
        """Delegate command building to the provider module."""
        if provider is not None:
            return provider.build_cmd(
                prompt=prompt,
                system_prompt=system_prompt,
                model=model,
                mcp_config=mcp_config,
                session_id=session_id,
                plugin_dir=plugin_dir,
            )
        # Unknown provider — best-effort generic invocation.
        print(
            f"[engine] unknown provider '{provider_name}', "
            f"trying generic invocation",
            file=sys.stderr, flush=True,
        )
        return [provider_name, f"{system_prompt}\n\n{prompt}"]

    def _build_mcp_config(
        self, plugin_name: str, job: Job, config: PluginConfig
    ) -> str:
        """Write a temporary MCP config file for Claude Code."""
        # Extract chat_id from session key.
        chat_id = ""
        if ":" in job.session_key:
            chat_id = job.session_key.split(":", 1)[1]

        # Pass chat_id via config arg. Secrets go via env vars so they
        # don't appear in process argv.
        server_config = json.dumps({"chat_id": chat_id})

        cli_dir = os.path.dirname(os.path.abspath(__file__))
        mcp_script = os.path.join(cli_dir, "mcp_server.py")

        # Env vars for the MCP server subprocess — inherits from current
        # env plus any plugin-specific overrides.
        mcp_env: dict[str, str] = {}
        for key in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_FILE",
                     "MESSAGING_PLATFORM"):
            val = config.get(key, "") or os.environ.get(key, "")
            if val:
                mcp_env[key] = val

        mcp_json = {
            "mcpServers": {
                "messaging": {
                    "command": "python3",
                    "args": [
                        mcp_script,
                        "--plugin", plugin_name,
                        "--config", server_config,
                    ],
                    "env": mcp_env,
                }
            }
        }

        # Write to temp file.
        fd, path = tempfile.mkstemp(suffix=".json", prefix="hivemoot-mcp-")
        with os.fdopen(fd, "w") as f:
            json.dump(mcp_json, f)

        return path


def _load_file_secrets() -> None:
    """Resolve *_FILE env vars into their non-file equivalents.

    Mirrors the bash contract in shared/lib.sh:load_provider_secrets():
    - If VAR_FILE is set but the file doesn't exist → fatal error
    - If both VAR and VAR_FILE are set → fatal error
    - If only VAR_FILE is set and file exists → read into VAR
    """
    file_vars = [
        ("OPENAI_API_KEY_FILE", "OPENAI_API_KEY"),
        ("ANTHROPIC_API_KEY_FILE", "ANTHROPIC_API_KEY"),
        ("GOOGLE_API_KEY_FILE", "GOOGLE_API_KEY"),
        ("GEMINI_API_KEY_FILE", "GEMINI_API_KEY"),
        ("OPENROUTER_API_KEY_FILE", "OPENROUTER_API_KEY"),
        ("ZAI_API_KEY_FILE", "ZAI_API_KEY"),
        ("CLAUDE_CODE_OAUTH_TOKEN_FILE", "CLAUDE_CODE_OAUTH_TOKEN"),
        ("KILOCODE_TOKEN_FILE", "KILOCODE_TOKEN"),
        ("HIVEMOOT_AGENT_TOKEN_FILE", "HIVEMOOT_AGENT_TOKEN"),
        ("TELEGRAM_BOT_TOKEN_FILE", "TELEGRAM_BOT_TOKEN"),
        ("GITHUB_TOKEN_FILE", "GITHUB_TOKEN"),
    ]
    for file_var, target_var in file_vars:
        file_path = os.environ.get(file_var, "")
        has_inline = bool(os.environ.get(target_var))

        if not file_path:
            continue

        if has_inline:
            print(
                f"[engine] FATAL: both {target_var} and {file_var} are set. "
                f"Use one or the other.",
                file=sys.stderr, flush=True,
            )
            raise SystemExit(1)

        if not os.path.isfile(file_path):
            print(
                f"[engine] FATAL: {file_var}={file_path} but file does not exist.",
                file=sys.stderr, flush=True,
            )
            raise SystemExit(1)

        with open(file_path) as f:
            os.environ[target_var] = f.read().strip()
        print(
            f"[engine] loaded {target_var} from {file_var}",
            file=sys.stderr, flush=True,
        )


def _extract_response(output: str) -> str:
    """Extract the agent's response from stream-json or plain output."""
    if not output:
        return ""

    # Try structured extraction (Claude result, Codex item.completed).
    result = ""
    for line in output.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "result":
            candidate = obj.get("result", "")
            if candidate:
                result = candidate
        if obj.get("type") == "item.completed":
            item = obj.get("item", {})
            if item.get("type") == "agent_message":
                text = item.get("text", "")
                if text:
                    result = text
    if result:
        return result

    # Fallback: longest non-JSON line.
    best = ""
    for line in output.strip().split("\n")[-50:]:
        stripped = line.strip()
        if not stripped or stripped.startswith("{"):
            continue
        if len(stripped) > len(best):
            best = stripped
    return best


def _append_agent_memory(system_prompt: str, repo: str = "") -> str:
    """Append memory content and write protocol based on AGENT_MEMORY_MODE.

    Modes (controlled by the trigger, passed as env var):
      rw   — inject memory content + write protocol (default)
      ro   — inject memory content only, no write instructions
      none — skip memory injection entirely

    When *repo* is provided, memory is scoped to a subdirectory so
    multi-repo plugin-engine runs don't share one MEMORY.md.
    """
    mode = os.environ.get("AGENT_MEMORY_MODE", "rw").strip() or "rw"
    if mode == "none":
        return system_prompt

    memory_dir = os.environ.get("AGENT_MEMORY_DIR", _DEFAULT_AGENT_MEMORY_DIR).strip()
    if not memory_dir:
        memory_dir = _DEFAULT_AGENT_MEMORY_DIR

    # Scope memory per-repo so multi-repo runs get isolated files.
    if repo:
        import re
        safe_repo = re.sub(r"[^A-Za-z0-9._-]", "_", repo)
        memory_dir = os.path.join(memory_dir, safe_repo)
        os.makedirs(memory_dir, exist_ok=True)

    memory_file = os.path.join(memory_dir, "MEMORY.md")

    has_memory = os.path.isfile(memory_file)

    # Nothing to inject: no existing memory and no write protocol to add.
    if not has_memory and mode != "rw":
        return system_prompt

    parts: list[str] = []

    # Inject existing memory content.
    if has_memory:
        try:
            with open(memory_file) as f:
                memory_text = f.read().strip()
        except OSError as exc:
            print(
                f"[engine] failed to read agent memory {memory_file}: {exc}",
                file=sys.stderr, flush=True,
            )
            memory_text = ""
        if memory_text:
            # Strip closing tag to prevent prompt injection via poisoned files.
            memory_text = memory_text.replace("</agent-memory>", "")
            parts.append(
                "<agent-memory>\n"
                "These are notes you wrote in prior runs. Use them to build on prior work.\n"
                "If anything conflicts with current repo state, trust the repo and update your memory.\n\n"
                f"{memory_text}\n"
                "</agent-memory>"
            )

    # Inject write protocol only in read-write mode.
    if mode == "rw":
        parts.append(
            "## Memory Protocol\n"
            f"You have persistent memory at `{memory_file}` that survives across runs.\n\n"
            "**Reading memory**: Your memory (if any) is included above in `<agent-memory>` tags. "
            "Use it to avoid rediscovering things you already know and to continue incomplete work.\n\n"
            "**Writing memory**: Update the memory file when you:\n"
            "- Discover architectural patterns or code conventions\n"
            "- Make or observe a significant decision (with rationale)\n"
            "- Encounter a gotcha or non-obvious behavior\n"
            "- Complete work that future runs should know about\n"
            "- Identify work that needs follow-up in a future run\n\n"
            "**Before finishing**: Review and update your memory file. Remove stale entries. "
            "Add what you learned this run.\n\n"
            "**Size limit**: Keep under ~200 lines. Consolidate related entries. "
            "Quality over quantity."
        )

    if not parts:
        return system_prompt

    memory_section = "\n\n".join(parts)
    if system_prompt:
        return f"{system_prompt}\n\n{memory_section}"
    return memory_section


class _PluginDispatcher:
    """JobDispatcher that runs the agent via the engine."""

    def __init__(
        self, engine: Engine, plugin: Any, config: PluginConfig,
        plugin_name: str,
    ) -> None:
        self._engine = engine
        self._plugin = plugin
        self._config = config
        self._plugin_name = plugin_name

    def dispatch(self, job: Job) -> bool:
        try:
            result = self._engine.run_agent(
                self._plugin, job, self._config, self._plugin_name
            )
            return result.exit_code == 0
        except Exception as exc:
            print(f"[engine] dispatch failed: {exc}", file=sys.stderr)
            return False
