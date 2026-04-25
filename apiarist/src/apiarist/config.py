"""Configuration loading for apiarist.

Source precedence (high → low):

    1. CLI args (--socket-path, --backend-url, --log-level, ...)
    2. Env vars (APIARIST_SOCKET_PATH, APIARIST_BACKEND_URL, ...)
    3. Optional config file (--config / /etc/apiarist/apiarist.yaml)
    4. Built-in defaults

See DESIGN.md §9 for the field list and the cache-eviction
rationale behind the safety_margin / max_seconds split.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, ValidationError

DEFAULT_CONFIG_PATH = Path("/etc/apiarist/apiarist.yaml")
ENV_PREFIX = "APIARIST_"

# Reserved env names that must NOT be pushed into the Config field
# overlay (they'd trip extra_forbidden). Each one is consumed elsewhere
# in the codebase:
#   - APIARIST_CONFIG       → the YAML file path (handled by _resolve_config_path)
#   - APIARIST_AGENT_TOKEN  → the bearer credential (read directly by __main__.py
#                             before constructing the BackendClient; see DESIGN.md
#                             §9 multi-token support — the secret never lives in
#                             Config because Config is logged at startup)
_NON_FIELD_ENV_KEYS: frozenset[str] = frozenset({"config", "agent_token"})

LogLevel = str  # validated to one of {debug, info, warning, error, critical}
_VALID_LOG_LEVELS = frozenset({"debug", "info", "warning", "error", "critical"})


class Config(BaseModel):
    """All apiarist runtime knobs (DESIGN.md §9)."""

    socket_path: Path = Path("/run/apiarist.sock")
    socket_group: str = "apiarist"
    backend_url: str = "https://www.hivemoot.dev"
    apiary_secrets_path: Path = Path("/opt/apiary/apiary.secrets.yaml")
    apiary_config_path: Path = Path("/opt/apiary/apiary.yaml")
    # Cache eviction = min(expires_at - safety_margin, now + max_seconds).
    # max_seconds default is 300 (5 min), NOT the upstream 1h TTL — see
    # DESIGN.md §9 for the tail-exposure-vs-burst-amortization rationale.
    # safety_margin is the budget for clock skew + in-flight latency
    # (matches @octokit/auth-app's 60s shave).
    token_cache_safety_margin_seconds: int = Field(default=60, ge=0)
    token_cache_max_seconds: int = Field(default=300, ge=60)
    backend_timeout_seconds: int = Field(default=10, ge=1)
    backend_retries: int = Field(default=3, ge=0)
    log_level: LogLevel = "info"

    # frozen so callers can't mutate config after load; extra=forbid catches
    # typos in YAML/env/CLI before they silently fall through to defaults.
    model_config = {"frozen": True, "extra": "forbid"}

    def model_post_init(self, __context: Any) -> None:
        if self.log_level not in _VALID_LOG_LEVELS:
            raise ValueError(
                f"log_level must be one of {sorted(_VALID_LOG_LEVELS)}, got {self.log_level!r}"
            )


class ConfigError(Exception):
    """Raised when the config file is malformed or contains invalid values."""


def load_config(
    cli_overlay: dict[str, Any] | None = None,
    env: dict[str, str] | None = None,
    config_path: Path | None = None,
) -> Config:
    """Build a Config instance from the four sources, layered in order.

    `cli_overlay` values that are None are dropped — that lets the caller
    pass an argparse Namespace as a dict where unset flags are None
    without those Nones overriding values from env or file.

    The YAML file path is resolved separately from the field overlays:
    `config_path` arg (typically from `--config`) > `APIARIST_CONFIG`
    env var > `DEFAULT_CONFIG_PATH`.
    """
    resolved_config_path = _resolve_config_path(config_path, env)

    layered: dict[str, Any] = {}
    layered.update(_load_file_overlay(resolved_config_path))
    layered.update(_load_env_overlay(env))
    if cli_overlay:
        layered.update({k: v for k, v in cli_overlay.items() if v is not None})

    try:
        return Config(**layered)
    except ValidationError as e:
        raise ConfigError(f"Config validation failed:\n{e}") from e


def _resolve_config_path(
    cli_path: Path | None,
    env: dict[str, str] | None,
) -> Path | None:
    """CLI > env (APIARIST_CONFIG) > caller-provided default.

    Returns None when neither CLI nor env specifies a path; callers
    fall back to ``DEFAULT_CONFIG_PATH`` via ``_load_file_overlay``.
    """
    if cli_path is not None:
        return cli_path
    env_dict = env if env is not None else dict(os.environ)
    env_path = env_dict.get(f"{ENV_PREFIX}CONFIG")
    if env_path:
        return Path(env_path)
    return None


def _load_file_overlay(config_path: Path | None) -> dict[str, Any]:
    """Load YAML file if it exists; return {} if not found.

    Missing file is normal — deployments without /etc/apiarist/apiarist.yaml
    rely entirely on env vars + defaults. Malformed YAML or non-mapping
    top level is fatal: the operator clearly intended config to apply
    and we'd silently ignore it otherwise.
    """
    path = config_path or DEFAULT_CONFIG_PATH
    if not path.exists():
        return {}
    try:
        with path.open(encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise ConfigError(f"Failed to parse {path}: {e}") from e
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConfigError(
            f"{path} must contain a YAML mapping at the top level "
            f"(got {type(data).__name__})"
        )
    return data


def _load_env_overlay(env: dict[str, str] | None) -> dict[str, Any]:
    """Extract APIARIST_* env vars and normalize keys to Config field names.

    Excludes keys reserved for non-field purposes (currently
    APIARIST_CONFIG, which is the YAML-file selector resolved by
    `_resolve_config_path` instead).
    """
    if env is None:
        env = dict(os.environ)
    overlay: dict[str, Any] = {}
    for key, value in env.items():
        if not key.startswith(ENV_PREFIX):
            continue
        field = key[len(ENV_PREFIX) :].lower()
        if field in _NON_FIELD_ENV_KEYS:
            continue
        overlay[field] = value
    return overlay
