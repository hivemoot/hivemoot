"""Engine — the core runtime that runs inside a long-lived container.

Loads plugins, starts triggers, runs the agent with MCP tools, and
fires plugin lifecycle callbacks.  One process, one container.

The agent communicates with the user through MCP tools (send_message,
send_file) — not through console output.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

from hivemoot_agent.plugins import registry
from hivemoot_agent.plugins.interfaces import AgentResult, Job, PluginConfig
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
        """Discover and validate plugins.

        When AGENT_PLUGINS is set, only the listed plugins are loaded and
        validation failures are hard errors.  When unset, all discovered
        plugins are loaded and those with config errors are skipped.

        Returns a dict of validated plugins, or None on fatal error.
        """
        registry.discover()
        all_plugins = registry.all()

        requested = os.environ.get("AGENT_PLUGINS", "").strip()

        if requested:
            # Explicit mode — only activate listed plugins.
            names = [n.strip() for n in requested.split(",") if n.strip()]
            selected: dict[str, Any] = {}
            had_error = False

            for name in names:
                plugin = all_plugins.get(name)
                if plugin is None:
                    print(
                        f"[engine] FATAL: requested plugin '{name}' not found. "
                        f"Available: {', '.join(all_plugins) or '(none)'}",
                        file=sys.stderr,
                    )
                    had_error = True
                    continue

                config = registry.config_for(name)
                errors = plugin.validate(config)
                if errors:
                    print(
                        f"[engine] FATAL: plugin '{name}' config invalid:",
                        file=sys.stderr,
                    )
                    for err in errors:
                        print(f"  - {err}", file=sys.stderr)
                    had_error = True
                else:
                    selected[name] = plugin

            if had_error:
                return None
            return selected

        # Auto-discover mode — skip plugins with config errors.
        if not all_plugins:
            print("No plugins found.", file=sys.stderr)
            return None

        enabled = {
            name: p
            for name, p in all_plugins.items()
            if registry.config_for(name).enabled
        }

        if not enabled:
            print("No plugins enabled.", file=sys.stderr)
            return None

        valid: dict[str, Any] = {}
        for name, plugin in enabled.items():
            config = registry.config_for(name)
            errors = plugin.validate(config)
            if errors:
                print(
                    f"[engine] skipping plugin '{name}' (config incomplete):",
                    file=sys.stderr,
                )
                for err in errors:
                    print(f"  - {err}", file=sys.stderr)
            else:
                valid[name] = plugin

        return valid if valid else None

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
            print("[engine] no plugins with valid config. Waiting...", file=sys.stderr)
            # Don't exit — let the container stay alive for debugging.
            try:
                while self._running:
                    time.sleep(60)
            except KeyboardInterrupt:
                pass
            return 0

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

        When AGENT_PLUGINS is set, loads the specified plugins, runs
        their setup hooks (e.g. clone repos), and uses their system
        prompts.  When unset, runs a plain agent with no plugin support.
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

        # Load plugins if explicitly requested.
        requested = os.environ.get("AGENT_PLUGINS", "").strip()
        plugins: dict[str, Any] | None = None
        if requested:
            plugins = self._resolve_plugins()
            if plugins is None:
                return 1

        # One-time plugin setup (clone repos, authenticate, etc.).
        job = Job(session_key="oneshot", prompt=prompt)
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

        cmd = self._build_provider_cmd(
            provider, provider_name, prompt, system_prompt,
            model, "", "",
        )

        plugin_label = ", ".join(plugins) if plugins else "none"
        print(
            f"[engine] oneshot: provider={provider_name} "
            f"plugins={plugin_label} prompt={len(prompt)} chars",
            file=sys.stderr, flush=True,
        )

        stdout = ""
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
        except subprocess.TimeoutExpired:
            exit_code = 124
            print("[engine] oneshot timed out", file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"[engine] oneshot failed: {exc}", file=sys.stderr, flush=True)
            exit_code = 1

        # Print the agent's response to stdout so callers can capture it.
        response = ""
        if exit_code == 0 and stdout:
            response = _extract_response(stdout)
            if response:
                print(response, flush=True)

        # Run plugin teardown hooks.
        if plugins:
            result = AgentResult(exit_code=exit_code, response=response)
            for name, plugin in plugins.items():
                plugin_config = registry.config_for(name)
                plugin.on_job_finished(job, result, plugin_config)

        return exit_code

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
        """Merge system prompts from all enabled plugins.

        Each plugin's prompt is wrapped in a <plugin> tag so the agent
        knows which capabilities come from which plugin.  Collected
        from ALL enabled plugins, not just the triggering one.
        """
        parts: list[str] = []
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
        header = "Your capabilities are provided by hivemoot agent plugins. Each <plugin> block describes one."
        return header + "\n\n" + "\n\n".join(parts)

    def run_agent(
        self,
        plugin: Any,
        job: Job,
        config: PluginConfig,
        plugin_name: str,
    ) -> AgentResult:
        """Run the agent with MCP tools from the plugin."""
        system_prompt = self._build_system_prompt()
        provider_name = config.get("AGENT_PROVIDER", "claude")
        provider = get_provider(provider_name)
        model = config.get("AGENT_MODEL", "") or ""

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

        cmd = self._build_provider_cmd(
            provider, provider_name, effective_prompt, system_prompt,
            model, mcp_config, session_id,
        )

        plugin.on_job_started(job, config)

        resume_label = f", resume={session_id[:12]}..." if is_resume else ""
        print(
            f"[engine] running agent (plugin={plugin_name}, "
            f"provider={provider_name}, "
            f"mcp={'yes' if mcp_config else 'no'}{resume_label})",
            file=sys.stderr, flush=True,
        )

        exit_code, stdout = self._run_subprocess(cmd, config)

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
            )
            exit_code, stdout = self._run_subprocess(cmd, config)

        # Clean up MCP config.
        if mcp_config and os.path.isfile(mcp_config):
            os.unlink(mcp_config)

        # Persist session on success.
        if exit_code == 0 and stdout and provider:
            new_session = provider.extract_session_id(stdout)
            if new_session and scoped_key and self._session_store:
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

        # Providers that don't support MCP (everything except Claude)
        # need the response extracted from stdout for delivery.
        response = ""
        if provider_name != "claude" and stdout:
            response = _extract_response(stdout)

        result = AgentResult(exit_code=exit_code, response=response)
        plugin.on_job_finished(job, result, config)
        return result

    def _run_subprocess(
        self, cmd: list[str], config: PluginConfig,
    ) -> tuple[int, str]:
        """Run an agent subprocess, returning (exit_code, stdout)."""
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=int(config.get("AGENT_TIMEOUT_SECONDS", "1800")),
            )
            print(
                f"[engine] agent exit={proc.returncode} "
                f"stdout={len(proc.stdout)} stderr={len(proc.stderr)}",
                file=sys.stderr, flush=True,
            )
            if proc.stderr:
                print(
                    f"[engine] stderr: {proc.stderr[:500]}",
                    file=sys.stderr, flush=True,
                )
            return (proc.returncode, proc.stdout)
        except subprocess.TimeoutExpired:
            print("[engine] agent timed out", file=sys.stderr, flush=True)
            return (124, "")
        except Exception as exc:
            print(f"[engine] agent failed: {exc}", file=sys.stderr, flush=True)
            return (1, "")

    @staticmethod
    def _build_provider_cmd(
        provider: Any,
        provider_name: str,
        prompt: str,
        system_prompt: str,
        model: str,
        mcp_config: str,
        session_id: str,
    ) -> list[str]:
        """Delegate command building to the provider module."""
        if provider is not None:
            return provider.build_cmd(
                prompt=prompt,
                system_prompt=system_prompt,
                model=model,
                mcp_config=mcp_config,
                session_id=session_id,
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
