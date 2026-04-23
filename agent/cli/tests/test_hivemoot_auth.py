"""Tests for hivemoot.auth — bearer token resolution."""

from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot import auth


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

    def test_empty_when_nothing_set(self) -> None:
        self.assertEqual(auth.resolve_agent_token(), "")

    def test_reads_from_explicit_path(self) -> None:
        with tempfile.NamedTemporaryFile(mode="w", delete=False) as f:
            f.write("tok-from-file\n")
            path = f.name
        try:
            self.assertEqual(auth.resolve_agent_token(path), "tok-from-file")
        finally:
            os.unlink(path)

    def test_falls_back_to_env_file(self) -> None:
        with tempfile.NamedTemporaryFile(mode="w", delete=False) as f:
            f.write("tok-from-env-file")
            path = f.name
        try:
            os.environ["HIVEMOOT_AGENT_TOKEN_FILE"] = path
            self.assertEqual(auth.resolve_agent_token(), "tok-from-env-file")
        finally:
            os.unlink(path)

    def test_falls_back_to_env_raw(self) -> None:
        os.environ["HIVEMOOT_AGENT_TOKEN"] = "tok-raw"
        self.assertEqual(auth.resolve_agent_token(), "tok-raw")

    def test_explicit_path_wins_over_env(self) -> None:
        os.environ["HIVEMOOT_AGENT_TOKEN"] = "tok-env"
        with tempfile.NamedTemporaryFile(mode="w", delete=False) as f:
            f.write("tok-explicit")
            path = f.name
        try:
            self.assertEqual(
                auth.resolve_agent_token(path), "tok-explicit",
            )
        finally:
            os.unlink(path)

    def test_oversize_file_refused(self) -> None:
        """A path pointing at a log file / binary must NOT be
        shipped as a Bearer header; the size guard catches this."""
        with tempfile.NamedTemporaryFile(mode="wb", delete=False) as f:
            f.write(b"x" * 8192)  # 2x the limit
            path = f.name
        try:
            os.environ["HIVEMOOT_AGENT_TOKEN_FILE"] = path
            stderr = io.StringIO()
            with patch("sys.stderr", stderr):
                out = auth.resolve_agent_token()
            self.assertEqual(out, "")
            self.assertIn("refusing to read", stderr.getvalue())
        finally:
            os.unlink(path)

    def test_oversize_file_falls_through_to_env(self) -> None:
        """When the file is oversize but HIVEMOOT_AGENT_TOKEN is set
        too, the env raw value wins rather than silently returning
        empty."""
        with tempfile.NamedTemporaryFile(mode="wb", delete=False) as f:
            f.write(b"x" * 8192)
            path = f.name
        try:
            os.environ["HIVEMOOT_AGENT_TOKEN_FILE"] = path
            os.environ["HIVEMOOT_AGENT_TOKEN"] = "tok-raw"
            with patch("sys.stderr", io.StringIO()):
                self.assertEqual(auth.resolve_agent_token(), "tok-raw")
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
