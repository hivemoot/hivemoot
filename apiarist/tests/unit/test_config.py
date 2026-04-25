"""Tests for apiarist.config — 4-layer precedence + validation."""

from __future__ import annotations

from pathlib import Path

import pytest

from apiarist.config import (
    DEFAULT_CONFIG_PATH,
    Config,
    ConfigError,
    load_config,
)


def test_defaults_when_no_overrides(tmp_path: Path) -> None:
    # Point at an explicit non-existent path so the system default
    # (/etc/apiarist/apiarist.yaml) doesn't accidentally apply if a
    # developer happens to have it on their machine.
    cfg = load_config(env={}, config_path=tmp_path / "missing.yaml")
    assert cfg.socket_path == Path("/run/apiarist.sock")
    assert cfg.socket_group == "apiarist"
    assert cfg.backend_url == "https://www.hivemoot.dev"
    assert cfg.token_cache_safety_margin_seconds == 600
    assert cfg.token_cache_max_seconds == 3000
    assert cfg.log_level == "info"


def test_file_overrides_defaults(tmp_path: Path) -> None:
    cfg_file = tmp_path / "apiarist.yaml"
    cfg_file.write_text(
        "socket_path: /tmp/apiarist.sock\nlog_level: debug\n"
    )
    cfg = load_config(env={}, config_path=cfg_file)
    assert cfg.socket_path == Path("/tmp/apiarist.sock")
    assert cfg.log_level == "debug"
    # untouched fields keep their defaults
    assert cfg.socket_group == "apiarist"


def test_env_overrides_file(tmp_path: Path) -> None:
    cfg_file = tmp_path / "apiarist.yaml"
    cfg_file.write_text("backend_url: https://file.example.com\n")
    cfg = load_config(
        env={"APIARIST_BACKEND_URL": "https://env.example.com"},
        config_path=cfg_file,
    )
    assert cfg.backend_url == "https://env.example.com"


def test_cli_overrides_env(tmp_path: Path) -> None:
    cfg = load_config(
        cli_overlay={"backend_url": "https://cli.example.com"},
        env={"APIARIST_BACKEND_URL": "https://env.example.com"},
        config_path=tmp_path / "missing.yaml",
    )
    assert cfg.backend_url == "https://cli.example.com"


def test_cli_none_does_not_override(tmp_path: Path) -> None:
    # argparse passes None for unset flags; those must NOT override
    # env values, otherwise a partial CLI surface clobbers config.
    cfg = load_config(
        cli_overlay={"backend_url": None, "log_level": "warning"},
        env={"APIARIST_BACKEND_URL": "https://env.example.com"},
        config_path=tmp_path / "missing.yaml",
    )
    assert cfg.backend_url == "https://env.example.com"
    assert cfg.log_level == "warning"


def test_missing_file_is_fine(tmp_path: Path) -> None:
    # No-op; just making sure no exception is raised when the file
    # simply doesn't exist (most production deployments).
    cfg = load_config(env={}, config_path=tmp_path / "does-not-exist.yaml")
    assert cfg.log_level == "info"


def test_default_config_path_constant() -> None:
    # Pin the default location — operators install to this path.
    assert Path("/etc/apiarist/apiarist.yaml") == DEFAULT_CONFIG_PATH


def test_malformed_yaml_raises_config_error(tmp_path: Path) -> None:
    cfg_file = tmp_path / "broken.yaml"
    cfg_file.write_text("socket_path: [unterminated\n")
    with pytest.raises(ConfigError, match="Failed to parse"):
        load_config(env={}, config_path=cfg_file)


def test_non_mapping_top_level_raises_config_error(tmp_path: Path) -> None:
    cfg_file = tmp_path / "list.yaml"
    cfg_file.write_text("- this\n- is\n- a\n- list\n")
    with pytest.raises(ConfigError, match="must contain a YAML mapping"):
        load_config(env={}, config_path=cfg_file)


def test_unknown_field_raises_config_error(tmp_path: Path) -> None:
    cfg_file = tmp_path / "typo.yaml"
    cfg_file.write_text("sokcet_path: /tmp/typo.sock\n")
    with pytest.raises(ConfigError):
        load_config(env={}, config_path=cfg_file)


def test_invalid_log_level_raises_config_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError):
        load_config(
            cli_overlay={"log_level": "verbose"},
            env={},
            config_path=tmp_path / "missing.yaml",
        )


def test_negative_safety_margin_raises_config_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError):
        load_config(
            env={"APIARIST_TOKEN_CACHE_SAFETY_MARGIN_SECONDS": "-1"},
            config_path=tmp_path / "missing.yaml",
        )


def test_max_seconds_below_minimum_raises_config_error(tmp_path: Path) -> None:
    # ge=60 — anything shorter than a minute is almost certainly a typo.
    with pytest.raises(ConfigError):
        load_config(
            env={"APIARIST_TOKEN_CACHE_MAX_SECONDS": "30"},
            config_path=tmp_path / "missing.yaml",
        )


def test_config_is_frozen(tmp_path: Path) -> None:
    cfg = load_config(env={}, config_path=tmp_path / "missing.yaml")
    with pytest.raises((TypeError, ValueError)):
        cfg.log_level = "debug"  # type: ignore[misc]


def test_empty_yaml_file_is_fine(tmp_path: Path) -> None:
    cfg_file = tmp_path / "empty.yaml"
    cfg_file.write_text("")
    cfg = load_config(env={}, config_path=cfg_file)
    assert cfg.log_level == "info"


def test_env_var_string_to_int_coercion(tmp_path: Path) -> None:
    # Env vars are always strings; pydantic coerces to int for numeric
    # fields. Verifies that boundary because env is the most common
    # production source of overrides.
    cfg = load_config(
        env={"APIARIST_BACKEND_TIMEOUT_SECONDS": "30"},
        config_path=tmp_path / "missing.yaml",
    )
    assert cfg.backend_timeout_seconds == 30


def test_unrelated_env_vars_ignored(tmp_path: Path) -> None:
    cfg = load_config(
        env={
            "PATH": "/usr/bin",
            "HOME": "/home/x",
            "NOT_APIARIST_BACKEND_URL": "https://noise.example",
        },
        config_path=tmp_path / "missing.yaml",
    )
    # Defaults preserved; nothing leaked from unrelated env.
    assert cfg.backend_url == "https://www.hivemoot.dev"


def test_config_construct_directly_for_unit_tests() -> None:
    # Direct instantiation is supported for tests that want a known
    # config without going through the loader.
    cfg = Config(log_level="warning", backend_retries=5)
    assert cfg.log_level == "warning"
    assert cfg.backend_retries == 5
