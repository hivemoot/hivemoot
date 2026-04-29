"""Tests for Engine.oneshot() and supporting functions."""

import json
import os
import subprocess
import sys
import threading
import time
import tempfile
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.engine import (
    Engine,
    _append_agent_memory,
    _extract_response,
    _load_file_secrets,
)
from hivemoot_agent.plugins.interfaces import AgentEvent, AgentResult, PluginConfig
from hivemoot_agent.providers.claude import extract_session_id as claude_extract_session_id
from hivemoot_agent.providers.codex import extract_session_id as codex_extract_session_id


# ── _extract_response tests ───────────────────────────────────────


def test_extract_claude_result():
    output = '{"type":"system","subtype":"init","session_id":"abc"}\n'
    output += '{"type":"result","result":"Hello from Claude"}\n'
    assert _extract_response(output) == "Hello from Claude"


def test_extract_codex_result():
    output = '{"type":"item.completed","item":{"type":"agent_message","text":"Hello from Codex"}}\n'
    assert _extract_response(output) == "Hello from Codex"


def test_extract_fallback():
    output = '{"type":"system"}\nHello plain text\n'
    assert _extract_response(output) == "Hello plain text"


def test_extract_empty():
    assert _extract_response("") == ""


def test_extract_last_result_wins():
    output = '{"type":"result","result":"first"}\n'
    output += '{"type":"result","result":"second"}\n'
    assert _extract_response(output) == "second"


# ── _extract_session_id tests ────────────────────────────────────


def test_extract_claude_session_id():
    output = '{"type":"system","subtype":"init","session_id":"abc-123"}\n'
    assert claude_extract_session_id(output) == "abc-123"


def test_extract_codex_session_id():
    output = '{"type":"thread.started","thread_id":"def-456"}\n'
    assert codex_extract_session_id(output) == "def-456"


def test_extract_session_id_no_match():
    assert claude_extract_session_id('{"type":"something_else"}\n') == ""
    assert codex_extract_session_id('{"type":"something_else"}\n') == ""


# ── Agent memory injection tests ─────────────────────────────────


def test_append_agent_memory_without_file(tmp_path):
    env = {"AGENT_MEMORY_DIR": str(tmp_path), "AGENT_MEMORY_MODE": "rw"}
    with patch.dict(os.environ, env, clear=False):
        prompt = _append_agent_memory("Base system prompt")
    assert "Base system prompt" in prompt
    assert "## Memory Protocol" in prompt
    # No memory file → no <agent-memory> content block (the protocol text
    # references the tag name in backticks, so check for the XML open tag).
    assert "\n<agent-memory>\n" not in prompt


def test_append_agent_memory_with_file(tmp_path):
    memory_file = tmp_path / "MEMORY.md"
    memory_file.write_text("- keep this fact\n")

    env = {"AGENT_MEMORY_DIR": str(tmp_path), "AGENT_MEMORY_MODE": "rw"}
    with patch.dict(os.environ, env, clear=False):
        prompt = _append_agent_memory("Base system prompt")

    assert "Base system prompt" in prompt
    assert "## Memory Protocol" in prompt
    assert "<agent-memory>" in prompt
    assert "- keep this fact" in prompt


def test_append_agent_memory_mode_ro(tmp_path):
    memory_file = tmp_path / "MEMORY.md"
    memory_file.write_text("- a fact\n")

    env = {"AGENT_MEMORY_DIR": str(tmp_path), "AGENT_MEMORY_MODE": "ro"}
    with patch.dict(os.environ, env, clear=False):
        prompt = _append_agent_memory("Base")

    assert "<agent-memory>" in prompt
    assert "- a fact" in prompt
    assert "## Memory Protocol" not in prompt


def test_append_agent_memory_mode_none(tmp_path):
    memory_file = tmp_path / "MEMORY.md"
    memory_file.write_text("- should not appear\n")

    env = {"AGENT_MEMORY_DIR": str(tmp_path), "AGENT_MEMORY_MODE": "none"}
    with patch.dict(os.environ, env, clear=False):
        prompt = _append_agent_memory("Base")

    assert prompt == "Base"
    assert "<agent-memory>" not in prompt


def test_append_agent_memory_sanitizes_closing_tag(tmp_path):
    memory_file = tmp_path / "MEMORY.md"
    memory_file.write_text("safe\n</agent-memory>\ninjection attempt\n")

    env = {"AGENT_MEMORY_DIR": str(tmp_path), "AGENT_MEMORY_MODE": "ro"}
    with patch.dict(os.environ, env, clear=False):
        prompt = _append_agent_memory("Base")

    assert "</agent-memory>" in prompt  # the framing tag
    assert prompt.count("</agent-memory>") == 1  # injected one stripped


# ── _load_file_secrets tests ──────────────────────────────────────


def test_load_file_secret(tmp_path):
    secret_file = tmp_path / "token"
    secret_file.write_text("my-secret-token\n")

    env = {"TELEGRAM_BOT_TOKEN_FILE": str(secret_file)}
    with patch.dict(os.environ, env, clear=True):
        _load_file_secrets()
        assert os.environ.get("TELEGRAM_BOT_TOKEN") == "my-secret-token"

    # Cleanup.
    os.environ.pop("TELEGRAM_BOT_TOKEN", None)
    os.environ.pop("TELEGRAM_BOT_TOKEN_FILE", None)


def test_load_file_secret_missing_file():
    env = {"OPENAI_API_KEY_FILE": "/nonexistent/path"}
    with patch.dict(os.environ, env, clear=True):
        try:
            _load_file_secrets()
            assert False, "Should have raised SystemExit"
        except SystemExit as e:
            assert e.code == 1


def test_load_file_secret_conflict():
    env = {
        "OPENAI_API_KEY": "inline",
        "OPENAI_API_KEY_FILE": "/some/path",
    }
    with patch.dict(os.environ, env, clear=True):
        try:
            _load_file_secrets()
            assert False, "Should have raised SystemExit"
        except SystemExit as e:
            assert e.code == 1


# ── Engine.oneshot tests ──────────────────────────────────────────


def test_oneshot_happy_path():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = '{"type":"result","result":"Agent says hello"}\n'
    mock_result.stderr = ""

    with patch("subprocess.run", return_value=mock_result):
        with patch.dict(os.environ, {"AGENT_PROVIDER": "claude"}, clear=False):
            engine = Engine()
            code = engine.oneshot(prompt="Say hello")
            assert code == 0


def test_oneshot_timeout():
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("cmd", 30)):
        with patch.dict(os.environ, {"AGENT_PROVIDER": "claude"}, clear=False):
            engine = Engine()
            code = engine.oneshot(prompt="Slow task")
            assert code == 124


def test_oneshot_failure():
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stdout = ""
    mock_result.stderr = "error"

    with patch("subprocess.run", return_value=mock_result):
        with patch.dict(os.environ, {"AGENT_PROVIDER": "claude"}, clear=False):
            engine = Engine()
            code = engine.oneshot(prompt="Bad task")
            assert code == 1


class _FakeSessionStore:
    def __init__(self, lookup_result=("", None)):
        self.lookup_result = lookup_result
        self.lookup_key = ""
        self.saved: list[dict[str, object]] = []
        self.map_file = "/tmp/fake-session-store.tsv"
        self.resume_enabled = True
        self.max_idle_hours = 12
        self.max_age_hours = 24
        self.reset_at_hour = None

    def lookup(self, key: str):
        self.lookup_key = key
        return self.lookup_result

    def save(self, key: str, session_id: str, *, was_resume: bool, prior_record):
        self.saved.append(
            {
                "key": key,
                "session_id": session_id,
                "was_resume": was_resume,
                "prior_record": prior_record,
            }
        )


class _FakePlugin:
    def __init__(self):
        self.finished_job = None

    def on_job_finished(self, job, result, config):
        self.finished_job = (job, result, config)


def test_oneshot_resumes_explicit_session_key_and_saves_new_session():
    store = _FakeSessionStore(
        lookup_result=("existing-session-id", {"created": 1, "last_used": 2})
    )
    plugin = _FakePlugin()
    seen_cmds = []

    def fake_run(cmd, **kwargs):
        seen_cmds.append(cmd)
        result = MagicMock()
        result.returncode = 0
        result.stdout = (
            '{"type":"thread.started","thread_id":"fresh-session-id"}\n'
            '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n'
        )
        result.stderr = ""
        return result

    env = {
        "AGENT_PROVIDER": "codex",
        "AGENT_PLUGINS": "github,hivemoot",
        "AGENT_SESSION_KEY": "mention-thread:123",
        "TARGET_REPO": "owner/repo",
        "AGENT_MEMORY_DIR": tempfile.gettempdir(),
    }
    with patch.dict(os.environ, env, clear=False):
        with patch("hivemoot_agent.engine.create_session_store", return_value=store):
            with patch.object(Engine, "_resolve_plugins", return_value={"fake": plugin}):
                with patch.object(Engine, "_setup_plugins", return_value=True):
                    with patch.object(Engine, "_build_system_prompt", return_value="System"):
                        with patch.object(Engine, "_build_skills_plugin_dir", return_value=""):
                            with patch("hivemoot_agent.engine.registry.config_for") as config_for:
                                config_for.side_effect = (
                                    lambda name: PluginConfig(name=name, settings=dict(os.environ))
                                )
                                with patch("subprocess.run", side_effect=fake_run):
                                    engine = Engine()
                                    code = engine.oneshot(prompt="Say hello")

    assert code == 0
    assert seen_cmds[0][:3] == ["codex", "exec", "resume"]
    assert "existing-session-id" in seen_cmds[0]
    assert store.lookup_key.endswith("|key=mention-thread:123")
    assert store.saved == [
        {
            "key": store.lookup_key,
            "session_id": "fresh-session-id",
            "was_resume": True,
            "prior_record": {"created": 1, "last_used": 2},
        }
    ]
    assert plugin.finished_job is not None
    assert plugin.finished_job[0].session_key == "mention-thread:123"


def test_oneshot_retries_fresh_after_resume_failure():
    store = _FakeSessionStore(
        lookup_result=("resume-session-id", {"created": 1, "last_used": 2})
    )
    plugin = _FakePlugin()
    seen_cmds = []
    call_count = 0

    def fake_run(cmd, **kwargs):
        nonlocal call_count
        call_count += 1
        seen_cmds.append(cmd)
        result = MagicMock()
        if call_count == 1:
            result.returncode = 1
            result.stdout = ""
            result.stderr = "resume failed"
            return result
        result.returncode = 0
        result.stdout = (
            '{"type":"thread.started","thread_id":"fresh-after-retry"}\n'
            '{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n'
        )
        result.stderr = ""
        return result

    env = {
        "AGENT_PROVIDER": "codex",
        "AGENT_PLUGINS": "github,hivemoot",
        "AGENT_SESSION_KEY": "mention-thread:retry",
        "TARGET_REPO": "owner/repo",
        "AGENT_MEMORY_DIR": tempfile.gettempdir(),
    }
    with patch.dict(os.environ, env, clear=False):
        with patch("hivemoot_agent.engine.create_session_store", return_value=store):
            with patch.object(Engine, "_resolve_plugins", return_value={"fake": plugin}):
                with patch.object(Engine, "_setup_plugins", return_value=True):
                    with patch.object(Engine, "_build_system_prompt", return_value="System"):
                        with patch.object(Engine, "_build_skills_plugin_dir", return_value=""):
                            with patch("hivemoot_agent.engine.registry.config_for") as config_for:
                                config_for.side_effect = (
                                    lambda name: PluginConfig(name=name, settings=dict(os.environ))
                                )
                                with patch("subprocess.run", side_effect=fake_run):
                                    engine = Engine()
                                    code = engine.oneshot(prompt="Retry me")

    assert code == 0
    assert len(seen_cmds) == 2
    assert seen_cmds[0][:3] == ["codex", "exec", "resume"]
    assert seen_cmds[1][:2] == ["codex", "exec"]
    assert seen_cmds[1][2] != "resume"
    assert store.saved == [
        {
            "key": store.lookup_key,
            "session_id": "fresh-after-retry",
            "was_resume": False,
            "prior_record": None,
        }
    ]


# ── _run_subprocess streaming tests ──────────────────────────────


def _make_mock_popen(stdout_lines, stderr_lines=None, returncode=0):
    """Create a mock Popen that yields lines from stdout/stderr."""
    mock_proc = MagicMock()
    mock_proc.stdout = iter(stdout_lines)
    mock_proc.stderr = iter(stderr_lines or [])
    mock_proc.returncode = returncode
    mock_proc.wait = MagicMock()
    mock_proc.kill = MagicMock()
    return mock_proc


def test_run_subprocess_streaming_calls_on_event():
    """Verify on_event receives AgentEvent objects from parsed lines."""
    import hivemoot_agent.providers.claude as claude_provider

    lines = [
        '{"type":"system","subtype":"init","session_id":"abc"}\n',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}\n',
        '{"type":"result","result":"Final answer"}\n',
    ]
    mock_proc = _make_mock_popen(lines)
    events: list[AgentEvent] = []

    with patch("subprocess.Popen", return_value=mock_proc):
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
        exit_code, stdout = engine._run_subprocess(
            ["echo"], config,
            on_event=lambda e: events.append(e),
            provider=claude_provider,
        )

    assert exit_code == 0
    assert len(events) == 3
    assert events[0].kind == "system"
    assert events[1].kind == "assistant_message"
    assert events[1].text == "Hello"
    assert events[2].kind == "result"
    assert events[2].text == "Final answer"


def test_run_subprocess_streaming_collects_stdout():
    """Returned stdout matches all lines concatenated."""
    import hivemoot_agent.providers.claude as claude_provider

    lines = ["line1\n", "line2\n", "line3\n"]
    mock_proc = _make_mock_popen(lines)

    with patch("subprocess.Popen", return_value=mock_proc):
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
        _, stdout = engine._run_subprocess(
            ["echo"], config, provider=claude_provider,
        )

    assert stdout == "line1\nline2\nline3\n"


def test_run_subprocess_callback_error_nonfatal():
    """on_event raising an exception doesn't crash the subprocess."""
    import hivemoot_agent.providers.claude as claude_provider

    lines = [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}\n',
        '{"type":"result","result":"Done"}\n',
    ]
    mock_proc = _make_mock_popen(lines)

    call_count = 0
    def exploding_callback(event):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("boom")

    with patch("subprocess.Popen", return_value=mock_proc):
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
        exit_code, stdout = engine._run_subprocess(
            ["echo"], config,
            on_event=exploding_callback,
            provider=claude_provider,
        )

    # Both lines were processed despite the first callback exploding.
    assert call_count == 2
    assert exit_code == 0


def test_run_subprocess_timeout_kills_process():
    """Timeout path kills the process and returns exit code 124."""
    mock_proc = MagicMock()
    mock_proc.stdout = iter([])
    mock_proc.stderr = iter([])
    # First wait() raises timeout; second wait() (after kill) succeeds.
    mock_proc.wait = MagicMock(
        side_effect=[subprocess.TimeoutExpired("cmd", 30), None],
    )
    mock_proc.kill = MagicMock()

    with patch("subprocess.Popen", return_value=mock_proc):
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "1"})
        exit_code, stdout = engine._run_subprocess(["echo"], config)

    assert exit_code == 124
    assert stdout == ""
    mock_proc.kill.assert_called_once()


def test_run_subprocess_slow_callback_does_not_truncate_stdout():
    """Slow event delivery must not drop later stdout lines."""
    import hivemoot_agent.providers.claude as claude_provider

    lines = [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Working on this now"}]}}\n',
        '{"type":"result","result":"Final answer"}\n',
    ]
    mock_proc = _make_mock_popen(lines)

    call_count = 0
    def slow_first_callback(event):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            time.sleep(10.2)

    with patch("subprocess.Popen", return_value=mock_proc):
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
        exit_code, stdout = engine._run_subprocess(
            ["echo"], config,
            on_event=slow_first_callback,
            provider=claude_provider,
        )

    assert exit_code == 0
    assert call_count == 2
    assert stdout == "".join(lines)


def test_run_subprocess_messaging_status_stays_off_critical_path():
    """Telegram status delivery must not delay subprocess completion."""
    import hivemoot_agent.providers.claude as claude_provider
    from hivemoot_agent.plugins.interfaces import Job
    from hivemoot_agent.plugins_builtin.messaging import MessagingPlugin

    started = threading.Event()
    release = threading.Event()

    class SlowAdapter:
        def send_and_get_id(self, config, chat_id, text):
            started.set()
            release.wait(timeout=2)
            return "42"

        def edit_message(self, config, chat_id, message_id, text):
            return True

        def delete_message(self, config, chat_id, message_id):
            return True

        def send(self, config, chat_id, text):
            return True

        def typing(self, config, chat_id):
            return True

    lines = [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Working on this now"}]}}\n',
        '{"type":"result","result":"Final answer"}\n',
    ]
    mock_proc = _make_mock_popen(lines)
    plugin = MessagingPlugin()
    plugin._platform_adapter = SlowAdapter()
    job = Job(session_key="tg:12345", prompt="hello")

    with patch("subprocess.Popen", return_value=mock_proc):
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
        plugin.on_job_started(job, config)
        start = time.monotonic()
        exit_code, stdout = engine._run_subprocess(
            ["echo"], config,
            on_event=lambda event: plugin.on_agent_output(job, event, config),
            provider=claude_provider,
        )
        elapsed = time.monotonic() - start

    assert exit_code == 0
    assert stdout == "".join(lines)
    assert elapsed < 0.2
    assert started.wait(timeout=1.0)

    release.set()
    plugin.on_job_finished(job, AgentResult(exit_code=0, response="Final answer"), config)
    plugin._status_queue.join()


def test_response_extracted_for_claude():
    """Response is extracted from stdout for Claude (no longer skipped)."""
    import hivemoot_agent.providers.claude as claude_provider

    lines = [
        '{"type":"system","subtype":"init","session_id":"abc"}\n',
        '{"type":"result","result":"Final Claude answer"}\n',
    ]
    mock_proc = _make_mock_popen(lines)
    mock_plugin = MagicMock()
    mock_plugin.on_agent_output = MagicMock()

    with patch("subprocess.Popen", return_value=mock_proc):
        with patch.dict(os.environ, {"AGENT_PROVIDER": "claude"}, clear=False):
            engine = Engine()
            engine._plugins = {"messaging": mock_plugin}

            # Call _run_subprocess + _extract_response the same way
            # run_agent does.
            config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
            _, stdout = engine._run_subprocess(
                ["echo"], config, provider=claude_provider,
            )
            response = _extract_response(stdout) if stdout else ""

    assert response == "Final Claude answer"


# ── prompt-via-stdin tests (E2BIG fix) ─────────────────────────────


def test_run_subprocess_pipes_prompt_via_stdin_for_claude():
    """Claude provider opts into prompt_via_stdin — engine writes prompt to subprocess stdin."""
    import hivemoot_agent.providers.claude as claude_provider

    mock_proc = _make_mock_popen(['{"type":"result","result":"ok"}\n'])
    big_prompt = "Review this PR\n" + ("X" * 200_000)  # > kernel argv ceiling

    with patch("subprocess.Popen", return_value=mock_proc) as popen_mock:
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
        engine._run_subprocess(
            ["claude", "-p"], config,
            provider=claude_provider,
            prompt=big_prompt,
        )

    # Popen received stdin=PIPE (not DEVNULL) because claude opted in
    popen_kwargs = popen_mock.call_args.kwargs
    assert popen_kwargs["stdin"] == subprocess.PIPE
    # The prompt was written to stdin and stdin was closed
    assert mock_proc.stdin.write.called
    written_prompt = mock_proc.stdin.write.call_args.args[0]
    assert written_prompt == big_prompt
    assert mock_proc.stdin.close.called


def test_run_subprocess_no_stdin_when_no_prompt():
    """Empty prompt → engine uses DEVNULL even with claude provider (no point piping nothing)."""
    import hivemoot_agent.providers.claude as claude_provider

    mock_proc = _make_mock_popen(['{"type":"result","result":"ok"}\n'])

    with patch("subprocess.Popen", return_value=mock_proc) as popen_mock:
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
        engine._run_subprocess(
            ["claude", "-p"], config,
            provider=claude_provider,
            prompt="",
        )

    popen_kwargs = popen_mock.call_args.kwargs
    assert popen_kwargs["stdin"] == subprocess.DEVNULL


def test_run_subprocess_no_stdin_for_provider_without_flag():
    """Codex doesn't set prompt_via_stdin — engine uses DEVNULL even with non-empty prompt."""
    import hivemoot_agent.providers.codex as codex_provider

    mock_proc = _make_mock_popen([])

    with patch("subprocess.Popen", return_value=mock_proc) as popen_mock:
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
        engine._run_subprocess(
            ["codex", "exec"], config,
            provider=codex_provider,
            prompt="some prompt that's already in argv via codex.build_cmd",
        )

    popen_kwargs = popen_mock.call_args.kwargs
    assert popen_kwargs["stdin"] == subprocess.DEVNULL


def test_run_subprocess_swallows_broken_pipe_on_stdin():
    """If claude exits before reading the full prompt, BrokenPipeError must not crash the writer."""
    import hivemoot_agent.providers.claude as claude_provider

    mock_proc = _make_mock_popen(['{"type":"result","result":"ok"}\n'])
    mock_proc.stdin.write.side_effect = BrokenPipeError("agent closed stdin early")

    with patch("subprocess.Popen", return_value=mock_proc):
        engine = Engine()
        config = PluginConfig(name="test", settings={"AGENT_TIMEOUT_SECONDS": "60"})
        # Should not raise — BrokenPipeError is swallowed in the writer thread
        exit_code, stdout = engine._run_subprocess(
            ["claude", "-p"], config,
            provider=claude_provider,
            prompt="anything",
        )

    # The write was attempted but failed; the read path still works
    assert exit_code == 0
    assert mock_proc.stdin.close.called  # finally-block always closes


def test_claude_build_cmd_omits_user_prompt_from_argv():
    """Regression for [Errno 7] Argument list too long: the user prompt
    must NOT appear in argv (it's piped via stdin instead). The
    --append-system-prompt is still inline because system_prompt is
    typically much smaller than the user prompt for PR-review jobs."""
    import hivemoot_agent.providers.claude as claude_provider

    huge_prompt = "X" * 500_000
    cmd = claude_provider.build_cmd(
        prompt=huge_prompt,
        system_prompt="you are a reviewer",
        model="",
        mcp_config="",
        session_id="",
    )

    # Iron-clad: NO argv element contains the huge prompt
    for arg in cmd:
        assert huge_prompt not in arg, (
            f"prompt leaked into argv element of length {len(arg)}: "
            f"{arg[:80]!r}..."
        )
    # The system_prompt is still inline (--append-system-prompt expects a string)
    assert "you are a reviewer" in cmd
    # And the engine reads this flag to decide stdin routing
    assert claude_provider.prompt_via_stdin is True


def test_claude_build_cmd_omits_user_prompt_with_resume():
    """Same regression covering the --resume code path."""
    import hivemoot_agent.providers.claude as claude_provider

    huge_prompt = "Y" * 500_000
    cmd = claude_provider.build_cmd(
        prompt=huge_prompt,
        system_prompt="ctx",
        model="",
        mcp_config="",
        session_id="abc-123",
    )

    for arg in cmd:
        assert huge_prompt not in arg
    assert "--resume" in cmd
    assert "abc-123" in cmd


if __name__ == "__main__":
    import inspect
    import tempfile

    passed = 0
    failed = 0
    for name, func in sorted(inspect.getmembers(sys.modules[__name__], inspect.isfunction)):
        if not name.startswith("test_"):
            continue
        try:
            # Provide tmp_path for tests that need it.
            params = inspect.signature(func).parameters
            if "tmp_path" in params:
                with tempfile.TemporaryDirectory() as td:
                    from pathlib import Path
                    func(Path(td))
            else:
                func()
            print(f"  \u2713 {name}")
            passed += 1
        except Exception as e:
            print(f"  \u2717 {name}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
