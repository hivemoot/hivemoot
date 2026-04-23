"""Tests for cli/hivemoot_agent/plugins_builtin/hivemoot/tasks/api.py."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.tasks import api as task_api


def _fake_response(status: int = 200, body: bytes = b"") -> MagicMock:
    cm = MagicMock()
    resp = cm.__enter__.return_value
    resp.status = status
    resp.read.return_value = body
    cm.__exit__.return_value = False
    return cm


class TokenResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {
            k: os.environ.pop(k, None)
            for k in ("HIVEMOOT_AGENT_TOKEN_FILE", "HIVEMOOT_AGENT_TOKEN")
        }

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is not None:
                os.environ[k] = v

    def test_returns_empty_when_unset(self) -> None:
        self.assertEqual(task_api.resolve_executor_token(""), "")

    def test_explicit_token_file_wins(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "tok")
            with open(path, "w") as f:
                f.write("explicit-token\n")
            os.environ["HIVEMOOT_AGENT_TOKEN"] = "raw-fallback"
            self.assertEqual(
                task_api.resolve_executor_token(path), "explicit-token",
            )

    def test_falls_back_to_env_token_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "env-tok")
            with open(path, "w") as f:
                f.write("env-file-token")
            os.environ["HIVEMOOT_AGENT_TOKEN_FILE"] = path
            self.assertEqual(
                task_api.resolve_executor_token(""), "env-file-token",
            )

    def test_falls_back_to_env_raw(self) -> None:
        os.environ["HIVEMOOT_AGENT_TOKEN"] = "raw-x"
        self.assertEqual(task_api.resolve_executor_token(""), "raw-x")

    def test_missing_explicit_path_falls_through(self) -> None:
        os.environ["HIVEMOOT_AGENT_TOKEN"] = "fallback"
        self.assertEqual(
            task_api.resolve_executor_token("/no/such/file"), "fallback",
        )

    def test_both_env_set_warns_and_uses_file(self) -> None:
        # B5 regression: project-wide convention is to forbid both
        # bare and _FILE.  resolve_executor_token now logs a warning
        # but keeps the file-wins behavior for compatibility.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "tok")
            with open(path, "w") as f:
                f.write("file-token")
            os.environ["HIVEMOOT_AGENT_TOKEN_FILE"] = path
            os.environ["HIVEMOOT_AGENT_TOKEN"] = "raw-token"
            stderr = io.StringIO()
            with patch("sys.stderr", stderr):
                token = task_api.resolve_executor_token("")
        self.assertEqual(token, "file-token")
        self.assertIn("both HIVEMOOT_AGENT_TOKEN_FILE and", stderr.getvalue())


class ClaimNextTaskTests(unittest.TestCase):
    def test_204_returns_none(self) -> None:
        with patch.object(
            task_api._OPENER, "open",
            return_value=_fake_response(204, b""),
        ):
            self.assertIsNone(
                task_api.claim_next_task("https://api.example/claim", "tok"),
            )

    def test_200_returns_parsed_task(self) -> None:
        body = json.dumps({
            "task": {
                "task_id": "task-1",
                "prompt": "do the thing",
                "repos": ["owner/repo"],
            },
            "claim_token": "ctok-xyz",
            "messages": [{"role": "user", "content": "hi"}],
        }).encode()
        with patch.object(
            task_api._OPENER, "open", return_value=_fake_response(200, body),
        ):
            claimed = task_api.claim_next_task(
                "https://api.example/claim", "tok",
            )
        assert claimed is not None
        self.assertEqual(claimed.task_id, "task-1")
        self.assertEqual(claimed.prompt, "do the thing")
        self.assertEqual(claimed.repo, "owner/repo")
        self.assertEqual(claimed.claim_token, "ctok-xyz")
        self.assertEqual(len(claimed.messages), 1)

    def test_200_missing_required_field_raises(self) -> None:
        # No claim_token → bad shape.
        body = json.dumps({
            "task": {
                "task_id": "x",
                "prompt": "y",
                "repos": ["o/r"],
            },
        }).encode()
        with patch.object(
            task_api._OPENER, "open", return_value=_fake_response(200, body),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                task_api.claim_next_task("https://api.example/claim", "tok")
        self.assertIn("missing required fields", str(ctx.exception))

    def test_200_no_repos_accepted(self) -> None:
        """A task is a unit of work, not a unit of code edit — the
        backend can dispatch repo-less tasks ("summarize governance",
        "draft RFC") and the plugin must not reject them."""
        body = json.dumps({
            "task": {
                "task_id": "generic-1",
                "prompt": "summarize the governance activity for 2026-04-17",
                "repos": [],
            },
            "claim_token": "ctok",
        }).encode()
        with patch.object(
            task_api._OPENER, "open", return_value=_fake_response(200, body),
        ):
            claimed = task_api.claim_next_task(
                "https://api.example/claim", "tok",
            )
        assert claimed is not None
        self.assertEqual(claimed.task_id, "generic-1")
        self.assertEqual(claimed.repo, "")
        self.assertEqual(claimed.repos, [])

    def test_200_missing_repos_field_accepted(self) -> None:
        """Even the ``repos`` field itself is optional — an older
        backend that omits it entirely must not break the claim."""
        body = json.dumps({
            "task": {
                "task_id": "generic-2",
                "prompt": "draft an RFC proposal",
            },
            "claim_token": "ctok",
        }).encode()
        with patch.object(
            task_api._OPENER, "open", return_value=_fake_response(200, body),
        ):
            claimed = task_api.claim_next_task(
                "https://api.example/claim", "tok",
            )
        assert claimed is not None
        self.assertEqual(claimed.repo, "")
        self.assertEqual(claimed.repos, [])

    def test_200_multi_repo_accepted(self) -> None:
        """Multi-repo tasks dispatch with ``.repos`` holding the full
        list; ``.repo`` is the first entry for backwards compat."""
        body = json.dumps({
            "task": {
                "task_id": "cross-1",
                "prompt": "coordinate change across both services",
                "repos": ["acme/api", "acme/web"],
            },
            "claim_token": "ctok",
        }).encode()
        with patch.object(
            task_api._OPENER, "open", return_value=_fake_response(200, body),
        ):
            claimed = task_api.claim_next_task(
                "https://api.example/claim", "tok",
            )
        assert claimed is not None
        self.assertEqual(claimed.repos, ["acme/api", "acme/web"])
        self.assertEqual(claimed.repo, "acme/api")

    def test_200_non_list_repos_field_rejected(self) -> None:
        """``repos`` must be a list (or absent) — a bare string or
        other type is a backend bug, surfaced immediately."""
        body = json.dumps({
            "task": {
                "task_id": "x",
                "prompt": "y",
                "repos": "owner/repo",
            },
            "claim_token": "ctok",
        }).encode()
        with patch.object(
            task_api._OPENER, "open", return_value=_fake_response(200, body),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                task_api.claim_next_task("https://api.example/claim", "tok")
        self.assertIn("must be a list", str(ctx.exception))

    def test_invalid_task_id_rejected(self) -> None:
        # B1 regression: backend-supplied identifiers must pass the
        # path-safety guards or claim_next_task raises (preventing
        # `.` / `..` from reaching the codex sidecar path).
        for bad in ("..", ".", "../etc/passwd", "with spaces"):
            with self.subTest(task_id=bad):
                body = json.dumps({
                    "task": {
                        "task_id": bad,
                        "prompt": "x",
                        "repos": ["o/r"],
                    },
                    "claim_token": "ctok",
                }).encode()
                with patch.object(
                    task_api._OPENER, "open",
                    return_value=_fake_response(200, body),
                ):
                    with self.assertRaises(RuntimeError) as ctx:
                        task_api.claim_next_task(
                            "https://api.example/claim", "tok",
                        )
                self.assertIn("invalid task_id", str(ctx.exception))

    def test_invalid_repo_rejected(self) -> None:
        # B1 regression: repo must be owner/repo with safe segments.
        for bad in ("../etc/passwd", "no-slash", "owner/.", "owner/.."):
            with self.subTest(repo=bad):
                body = json.dumps({
                    "task": {
                        "task_id": "good-id",
                        "prompt": "x",
                        "repos": [bad],
                    },
                    "claim_token": "ctok",
                }).encode()
                with patch.object(
                    task_api._OPENER, "open",
                    return_value=_fake_response(200, body),
                ):
                    with self.assertRaises(RuntimeError) as ctx:
                        task_api.claim_next_task(
                            "https://api.example/claim", "tok",
                        )
                self.assertIn("invalid repo", str(ctx.exception))

    def test_500_raises(self) -> None:
        with patch.object(
            task_api._OPENER, "open",
            return_value=_fake_response(500, b"internal error"),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                task_api.claim_next_task("https://api.example/claim", "tok")
        self.assertIn("status 500", str(ctx.exception))

    def test_bad_url_scheme_raises(self) -> None:
        with self.assertRaises(ValueError):
            task_api.claim_next_task("ftp://api.example/claim", "tok")


class PostUpdateTests(unittest.TestCase):
    def test_heartbeat_sends_correct_url_and_payload(self) -> None:
        captured: dict = {}

        def fake_open(req, timeout=None):
            captured["url"] = req.full_url
            captured["body"] = json.loads(req.data)
            captured["headers"] = dict(req.header_items())
            return _fake_response(200, b"")

        with patch.object(task_api._OPENER, "open", fake_open):
            ok = task_api.post_heartbeat(
                "https://api.example/api/tasks", "task-7", "tok", "ctok",
            )
        self.assertTrue(ok)
        self.assertEqual(
            captured["url"], "https://api.example/api/tasks/task-7/execute",
        )
        self.assertEqual(captured["body"], {"action": "heartbeat"})
        self.assertEqual(captured["headers"]["Authorization"], "Bearer tok")
        # urllib's add_header normalizes via .capitalize() on each
        # word — verify the header is set, not the exact case.
        normalized = {k.lower(): v for k, v in captured["headers"].items()}
        self.assertEqual(normalized["x-task-claim-token"], "ctok")

    def test_complete_includes_result(self) -> None:
        captured: dict = {}

        def fake_open(req, timeout=None):
            captured["body"] = json.loads(req.data)
            return _fake_response(200, b"")

        with patch.object(task_api._OPENER, "open", fake_open):
            task_api.post_complete(
                "https://api.example/api/tasks", "task-7", "tok", "ctok",
                "## Done",
            )
        self.assertEqual(
            captured["body"],
            {"action": "complete", "result": "## Done"},
        )

    def test_fail_includes_error(self) -> None:
        captured: dict = {}

        def fake_open(req, timeout=None):
            captured["body"] = json.loads(req.data)
            return _fake_response(200, b"")

        with patch.object(task_api._OPENER, "open", fake_open):
            task_api.post_fail(
                "https://api.example/api/tasks", "task-7", "tok", "ctok",
                "boom",
            )
        self.assertEqual(captured["body"], {"action": "fail", "error": "boom"})

    def test_non_200_returns_false(self) -> None:
        with patch.object(
            task_api._OPENER, "open",
            return_value=_fake_response(500, b""),
        ):
            self.assertFalse(
                task_api.post_heartbeat(
                    "https://api.example/api/tasks", "x", "t", "c",
                ),
            )

    def test_transport_error_returns_false(self) -> None:
        def boom(req, timeout=None):
            raise urllib.error.URLError("connection refused")

        with patch.object(task_api._OPENER, "open", boom):
            self.assertFalse(
                task_api.post_heartbeat(
                    "https://api.example/api/tasks", "x", "t", "c",
                ),
            )

    def test_redirect_blocked_to_protect_authorization(self) -> None:
        # Smoke-test the no-redirect handler refuses 302 with a useful
        # message (full coverage in test_health_cli.py).
        handler = task_api._NoRedirectHandler()
        req = MagicMock()
        req.full_url = "https://api.example/x"
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            handler.http_error_302(
                req, fp=io.BytesIO(b""), code=302, msg="Found",
                headers={"Location": "https://attacker/"},
            )
        self.assertIn("Authorization", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
