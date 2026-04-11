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


class Engine:
    """Loads plugins, starts triggers, runs agents with MCP tools."""

    def __init__(self) -> None:
        self._running = True
        # session_key → claude session_id for --resume.
        self._sessions: dict[str, str] = {}

    def run(self) -> int:
        """Main entry point.  Blocks until shutdown."""
        _load_file_secrets()
        registry.discover()
        plugins = registry.all()

        if not plugins:
            print("No plugins found.", file=sys.stderr)
            return 1

        enabled = {
            name: p
            for name, p in plugins.items()
            if registry.config_for(name).enabled
        }

        if not enabled:
            print("No plugins enabled.", file=sys.stderr)
            return 1

        # Validate plugins — skip those with config errors instead of failing.
        valid: dict[str, Any] = {}
        for name, plugin in enabled.items():
            config = registry.config_for(name)
            errors = plugin.validate(config)
            if errors:
                print(f"[engine] skipping plugin '{name}' (config incomplete):", file=sys.stderr)
                for err in errors:
                    print(f"  - {err}", file=sys.stderr)
            else:
                valid[name] = plugin
        enabled = valid

        if not enabled:
            print("[engine] no plugins with valid config. Waiting...", file=sys.stderr)
            # Don't exit — let the container stay alive for debugging.
            try:
                while self._running:
                    time.sleep(60)
            except KeyboardInterrupt:
                pass
            return 0

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

    def run_agent(
        self,
        plugin: Any,
        job: Job,
        config: PluginConfig,
        plugin_name: str,
    ) -> AgentResult:
        """Run the agent with MCP tools from the plugin."""
        system_prompt = plugin.system_prompt(config)
        provider = config.get("AGENT_PROVIDER", "claude")

        # Build MCP config so the agent can call plugin tools.
        mcp_config = self._build_mcp_config(plugin_name, job, config)

        # Resume from previous session if available.
        session_id = self._sessions.get(job.session_key, "")

        cmd = self._build_agent_cmd(
            provider, system_prompt, job.prompt, mcp_config, config,
            session_id=session_id,
        )

        plugin.on_job_started(job, config)

        print(
            f"[engine] running agent (plugin={plugin_name}, "
            f"mcp={'yes' if mcp_config else 'no'})",
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
                f"[engine] agent exit={exit_code} "
                f"stdout={len(stdout)} stderr={len(proc.stderr)}",
                file=sys.stderr, flush=True,
            )
            if proc.stderr:
                print(
                    f"[engine] stderr: {proc.stderr[:500]}",
                    file=sys.stderr, flush=True,
                )
        except subprocess.TimeoutExpired:
            exit_code = 124
            print("[engine] agent timed out", file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"[engine] agent failed: {exc}", file=sys.stderr, flush=True)
            exit_code = 1

        # Clean up MCP config.
        if mcp_config and os.path.isfile(mcp_config):
            os.unlink(mcp_config)

        # Extract session_id from stream-json for --resume on next message.
        if exit_code == 0 and provider == "claude" and stdout:
            new_session = _extract_session_id(stdout)
            if new_session:
                self._sessions[job.session_key] = new_session
                print(
                    f"[engine] session saved: {job.session_key} → {new_session[:12]}...",
                    file=sys.stderr, flush=True,
                )

        # For providers without MCP (Codex, Gemini), extract the
        # response from stdout so on_job_finished can deliver it.
        response = ""
        if provider != "claude" and stdout:
            response = _extract_response(stdout)

        result = AgentResult(exit_code=exit_code, response=response)
        plugin.on_job_finished(job, result, config)
        return result

    def _build_agent_cmd(
        self,
        provider: str,
        system_prompt: str,
        prompt: str,
        mcp_config: str,
        config: PluginConfig,
        session_id: str = "",
    ) -> list[str]:
        """Build the agent CLI command for the given provider."""
        model = config.get("AGENT_MODEL", "")

        if provider == "claude":
            if session_id:
                # Resume existing session.
                cmd = [
                    "claude", "--resume", session_id, "-p",
                    "--verbose",
                    "--output-format", "stream-json",
                    "--dangerously-skip-permissions",
                    "--append-system-prompt", system_prompt,
                ]
            else:
                # Fresh session.
                cmd = [
                    "claude", "-p",
                    "--verbose",
                    "--output-format", "stream-json",
                    "--dangerously-skip-permissions",
                    "--append-system-prompt", system_prompt,
                ]
            if mcp_config:
                cmd += ["--mcp-config", mcp_config]
            if model:
                cmd += ["--model", model]
            cmd += ["--", prompt]
            return cmd

        combined = f"{system_prompt}\n\n{prompt}"

        if provider == "codex":
            cmd = ["codex", "exec"]
            if model:
                cmd += ["--model", model]
            cmd += [combined]
            return cmd

        if provider == "gemini":
            cmd = ["gemini", "--yolo"]
            if model:
                cmd += ["-m", model]
            cmd += ["-p", combined]
            return cmd

        if provider == "kilo":
            cmd = ["kilo", "run", "--auto"]
            if model:
                cmd += ["--model", model]
            cmd += [combined]
            return cmd

        if provider == "opencode":
            cmd = ["opencode", "run"]
            if model:
                cmd += ["--model", model]
            cmd += [combined]
            return cmd

        # Unknown provider — try common pattern.
        print(
            f"[engine] unknown provider '{provider}', trying generic invocation",
            file=sys.stderr, flush=True,
        )
        cmd = [provider, combined]
        return cmd

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


def _extract_session_id(output: str) -> str:
    """Extract Claude session_id from stream-json init event."""
    for line in output.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "system" and obj.get("subtype") == "init":
            return obj.get("session_id", "")
    return ""


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
