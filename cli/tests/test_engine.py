"""Tests for Engine.oneshot() and supporting functions."""

import json
import os
import sys
import subprocess
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.engine import Engine, _extract_response, _load_file_secrets


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
