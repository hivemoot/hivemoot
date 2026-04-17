"""Tests for the host-side messaging CLI (preflight, watch, send).

Patches `_api` at the source module instead of urllib so we do not
need to fake HTTP responses — the adapter's own HTTP layer is
unit-tested elsewhere via its behavior under real urllib.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from typing import Any
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.messaging import cli as messaging_cli


def _make_args(**kwargs: Any) -> argparse.Namespace:
    return argparse.Namespace(**kwargs)


class PreflightTests(unittest.TestCase):
    def test_unknown_platform_fails(self) -> None:
        args = _make_args(platform="whatsapp")
        self.assertEqual(messaging_cli.cmd_preflight(args), 1)

    def test_missing_token_fails(self) -> None:
        # No TELEGRAM_BOT_TOKEN / _FILE in env → adapter surfaces a
        # validation error and preflight returns 1.
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TELEGRAM_BOT_TOKEN", None)
            os.environ.pop("TELEGRAM_BOT_TOKEN_FILE", None)
            args = _make_args(platform="telegram")
            self.assertEqual(messaging_cli.cmd_preflight(args), 1)

    def test_token_ok(self) -> None:
        def fake_api(token: str, method: str, data: dict | None = None) -> dict:
            assert method == "getMe"
            return {"ok": True, "result": {"username": "hivemoot_bot"}}

        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "fake-token"}, clear=False), \
             patch(
            "hivemoot_agent.plugins_builtin.messaging.platforms.telegram._api",
            fake_api,
        ):
            args = _make_args(platform="telegram")
            self.assertEqual(messaging_cli.cmd_preflight(args), 0)

    def test_token_invalid_fails(self) -> None:
        def fake_api(token: str, method: str, data: dict | None = None) -> dict:
            return {"ok": False, "description": "Unauthorized"}

        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "bad-token"}, clear=False), \
             patch(
            "hivemoot_agent.plugins_builtin.messaging.platforms.telegram._api",
            fake_api,
        ):
            args = _make_args(platform="telegram")
            self.assertEqual(messaging_cli.cmd_preflight(args), 1)


class OffsetFileTests(unittest.TestCase):
    def test_read_missing_returns_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(
                messaging_cli._read_offset(os.path.join(tmp, "nope")), 0,
            )

    def test_read_existing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "offset")
            with open(path, "w") as f:
                f.write("42\n")
            self.assertEqual(messaging_cli._read_offset(path), 42)

    def test_read_invalid_returns_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "offset")
            with open(path, "w") as f:
                f.write("garbage")
            self.assertEqual(messaging_cli._read_offset(path), 0)

    def test_write_atomic_creates_parent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "nested", "offset")
            messaging_cli._write_offset(path, 99)
            with open(path) as f:
                self.assertEqual(f.read(), "99")

    def test_write_replaces_existing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "offset")
            messaging_cli._write_offset(path, 1)
            messaging_cli._write_offset(path, 2)
            with open(path) as f:
                self.assertEqual(f.read(), "2")


class WatchTests(unittest.TestCase):
    def _run_watch_until_api_stops(
        self, token: str, offset_file: str, api_responses: list[dict],
    ) -> tuple[int, list[str]]:
        """Run cmd_watch with a fake _api that stops after api_responses.

        Returns (exit_code, captured_stdout_lines).  Raising StopIteration
        from the fake _api leaves the CLI's inner try/except to catch and
        return 1 — mimicking a real transport error.
        """
        responses = iter(api_responses)

        def fake_api(tok: str, method: str, data: dict | None = None) -> dict:
            return next(responses)

        captured = io.StringIO()

        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": token}, clear=False), \
             patch(
                 "hivemoot_agent.plugins_builtin.messaging.platforms.telegram._api",
                 fake_api,
             ), patch("sys.stdout", captured):
            args = _make_args(
                platform="telegram",
                offset_file=offset_file,
                poll_timeout=1,
            )
            exit_code = messaging_cli.cmd_watch(args)

        return exit_code, [
            line for line in captured.getvalue().splitlines() if line
        ]

    def test_emits_ndjson_for_message(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            offset_file = os.path.join(tmp, "offset")
            api_responses = [
                {
                    "ok": True,
                    "result": [{
                        "update_id": 1001,
                        "message": {
                            "chat": {"id": 55555},
                            "from": {"username": "alice"},
                            "text": "hello",
                        },
                    }],
                },
            ]
            exit_code, lines = self._run_watch_until_api_stops(
                "fake-token", offset_file, api_responses,
            )

            # StopIteration from the fake _api propagates as an error exit.
            self.assertEqual(exit_code, 1)
            self.assertEqual(len(lines), 1)
            payload = json.loads(lines[0])
            self.assertEqual(payload, {
                "update_id": 1001,
                "chat_id": "55555",
                "username": "alice",
                "text": "hello",
            })

            # Offset advanced past the processed update.
            with open(offset_file) as f:
                self.assertEqual(f.read(), "1002")

    def test_skips_empty_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            offset_file = os.path.join(tmp, "offset")
            api_responses = [
                {
                    "ok": True,
                    "result": [{
                        "update_id": 500,
                        "message": {
                            "chat": {"id": 1},
                            "from": {"username": "bob"},
                            # No text (e.g., photo-only update).
                        },
                    }],
                },
            ]
            exit_code, lines = self._run_watch_until_api_stops(
                "fake-token", offset_file, api_responses,
            )

            self.assertEqual(exit_code, 1)
            self.assertEqual(lines, [])
            with open(offset_file) as f:
                self.assertEqual(f.read(), "501")

    def test_resumes_from_stored_offset(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            offset_file = os.path.join(tmp, "offset")
            with open(offset_file, "w") as f:
                f.write("9000")

            captured_offsets: list[int] = []

            def fake_api(
                tok: str, method: str, data: dict | None = None,
            ) -> dict:
                if data and "offset" in data:
                    captured_offsets.append(data["offset"])
                raise StopIteration

            with patch.dict(
                os.environ, {"TELEGRAM_BOT_TOKEN": "x"}, clear=False,
            ), patch(
                "hivemoot_agent.plugins_builtin.messaging.platforms.telegram._api",
                fake_api,
            ), patch("sys.stdout", io.StringIO()):
                args = _make_args(
                    platform="telegram",
                    offset_file=offset_file,
                    poll_timeout=1,
                )
                messaging_cli.cmd_watch(args)

            self.assertEqual(captured_offsets, [9000])

    def test_exits_on_api_not_ok(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            offset_file = os.path.join(tmp, "offset")
            api_responses = [{"ok": False, "description": "token revoked"}]
            exit_code, lines = self._run_watch_until_api_stops(
                "fake-token", offset_file, api_responses,
            )
            self.assertEqual(exit_code, 1)
            self.assertEqual(lines, [])


class SendTests(unittest.TestCase):
    def test_empty_stdin_fails(self) -> None:
        with patch("sys.stdin", io.StringIO("")):
            args = _make_args(platform="telegram", chat_id="55555")
            self.assertEqual(messaging_cli.cmd_send(args), 1)

    def test_sends_to_adapter(self) -> None:
        captured: dict = {}

        def fake_api(
            token: str, method: str, data: dict | None = None,
        ) -> dict:
            captured.setdefault("calls", []).append((method, data))
            if method == "sendMessage":
                return {"ok": True, "result": {"message_id": 77}}
            return {"ok": True}

        with patch.dict(
            os.environ, {"TELEGRAM_BOT_TOKEN": "fake-token"}, clear=False,
        ), patch(
            "hivemoot_agent.plugins_builtin.messaging.platforms.telegram._api",
            fake_api,
        ), patch("sys.stdin", io.StringIO("hello from busy-ack")):
            args = _make_args(platform="telegram", chat_id="55555")
            exit_code = messaging_cli.cmd_send(args)

        self.assertEqual(exit_code, 0)
        send_calls = [c for c in captured["calls"] if c[0] == "sendMessage"]
        self.assertGreaterEqual(len(send_calls), 1)
        _, body = send_calls[0]
        self.assertEqual(body["chat_id"], "55555")
        # The adapter runs Markdown->HTML; plain text passes through.
        self.assertIn("hello from busy-ack", body["text"])

    def test_unknown_platform_fails(self) -> None:
        with patch("sys.stdin", io.StringIO("body")):
            args = _make_args(platform="bogus", chat_id="x")
            self.assertEqual(messaging_cli.cmd_send(args), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
