"""Smoke test for the Phase A scaffold.

Verifies the package imports, version is exposed, and the CLI exit code
is 0. Real unit tests for config/ipc/cache/backend land in Phase G.
"""

from __future__ import annotations

import re

import apiarist
from apiarist.__main__ import main
from apiarist.version import __version__


def test_version_is_semver_like() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", __version__), __version__


def test_package_re_exports_version() -> None:
    assert apiarist.__version__ == __version__


def test_cli_exits_zero_with_no_args() -> None:
    assert main([]) == 0
