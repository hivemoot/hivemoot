"""Smoke test — package import + CLI top-level error paths.

The daemon-loop tests live in tests/integration/test_server_e2e.py;
this file only verifies that:
  - the package imports cleanly,
  - version is exposed and semver-shaped,
  - the CLI surfaces an error (exit 1) when required env is missing.
"""

from __future__ import annotations

import re

import pytest

import apiarist
from apiarist.__main__ import main
from apiarist.version import __version__


def test_version_is_semver_like() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", __version__), __version__


def test_package_re_exports_version() -> None:
    assert apiarist.__version__ == __version__


def test_cli_without_agent_token_exits_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """Phase D+E+F made the daemon real. Without APIARIST_AGENT_TOKEN
    set the daemon can't authenticate to the backend, so it should
    fail fast with exit 1 rather than start a half-functional loop."""
    monkeypatch.delenv("APIARIST_AGENT_TOKEN", raising=False)
    assert main([]) == 1


def test_cli_version_flag_exits_via_argparse() -> None:
    """argparse calls sys.exit(0) for --version. We just want to
    verify it exits cleanly (not 1) and doesn't reach the daemon."""
    with pytest.raises(SystemExit) as exc_info:
        main(["--version"])
    assert exc_info.value.code == 0
