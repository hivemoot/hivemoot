"""ConfigLoader — read, resolve, and validate hivemoot.yaml.

Public entry point for the engine.  Given a main config path (and
optional secrets path), returns a structured object the engine
consumes to discover + activate + configure plugins.

Lifecycle:

  1. Parse hivemoot.yaml with the custom YAML loader that constructs
     ``SecretRef`` objects for ``!secret`` tags.
  2. Parse hivemoot.secrets.yaml (or skip if missing).
  3. Walk the parsed tree, swap SecretRef nodes for their values.
  4. Walk again, interpolate ``${env:VAR}`` occurrences.
  5. Return a LoadedConfig with top-level sections + per-plugin raw
     dicts.  Plugin-specific validation (Pydantic) happens later
     in the registry when the plugin is activated.

This separation matters: the loader doesn't know what plugins exist
or what they accept.  It only resolves the YAML into a plain tree
that the registry can slice up and hand to each plugin's schema.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from hivemoot_agent.config.resolver import (
    SecretRef,
    UnresolvedRefError,
    resolve_env_interpolations,
    resolve_secret_refs,
)


# Default paths inside the runtime container.  Operators override via
# the AGENT_CONFIG_FILE / AGENT_SECRETS_FILE env vars when using
# non-standard mounts (tests, local dev, etc.).
_DEFAULT_CONFIG_PATH = "/run/agent/hivemoot.yaml"
_DEFAULT_SECRETS_PATH = "/run/agent/hivemoot.secrets.yaml"


class ConfigLoadError(Exception):
    """Raised for any user-fixable problem loading hivemoot.yaml.

    Message always names the file + line / path when possible so the
    operator can jump straight to the offending YAML.  Never swallowed
    silently — the engine exits non-zero on this exception at startup.
    """


@dataclass
class PluginEntry:
    """One plugin instance from the ``plugins:`` section.

    Under ADR-003 the YAML key IS the plugin type — one instance per
    type.  ``instance_name`` and ``type_name`` are therefore always
    equal, but we keep both fields so the eventual multi-instance
    work can introduce a real distinction without changing the
    engine's consumption of this struct.

    ``raw_config`` is the already-resolved dict (secrets + env
    interpolations applied) ready to hand to the plugin's Pydantic
    schema for validation.
    """

    instance_name: str
    type_name: str
    raw_config: dict[str, Any]


@dataclass
class LoadedConfig:
    """Fully-resolved hivemoot.yaml contents, ready for the engine."""

    agent: dict[str, Any] = field(default_factory=dict)
    plugins: list[PluginEntry] = field(default_factory=list)
    source_path: Path | None = None
    secrets_path: Path | None = None


class ConfigLoader:
    """Orchestrates YAML parsing → secret resolution → env interpolation."""

    def __init__(
        self,
        config_path: str | Path | None = None,
        secrets_path: str | Path | None = None,
    ) -> None:
        self._config_path = Path(
            config_path or os.environ.get("AGENT_CONFIG_FILE", _DEFAULT_CONFIG_PATH)
        )
        resolved_secrets = (
            secrets_path
            or os.environ.get("AGENT_SECRETS_FILE")
            or _DEFAULT_SECRETS_PATH
        )
        self._secrets_path = Path(resolved_secrets) if resolved_secrets else None

    def load(self) -> LoadedConfig:
        """Read + resolve + structure hivemoot.yaml.

        Does NOT validate individual plugin config sections — that
        happens later in the registry where each plugin's Pydantic
        schema is known.  Returns whatever the YAML + resolver
        produced, so even partial / malformed-but-parseable configs
        surface to the caller for better error messages.
        """
        if not self._config_path.is_file():
            raise ConfigLoadError(
                f"Config file not found: {self._config_path}.  "
                "Set AGENT_CONFIG_FILE to override the default "
                f"({_DEFAULT_CONFIG_PATH})."
            )

        raw_config = _load_yaml_with_secret_tag(self._config_path)
        if not isinstance(raw_config, dict):
            raise ConfigLoadError(
                f"{self._config_path}: top-level must be a mapping, got "
                f"{type(raw_config).__name__}"
            )

        secrets: dict[str, Any] = {}
        if self._secrets_path and self._secrets_path.is_file():
            secrets_raw = _load_yaml_with_secret_tag(self._secrets_path)
            if secrets_raw is None:
                secrets = {}
            elif isinstance(secrets_raw, dict):
                secrets = secrets_raw
            else:
                raise ConfigLoadError(
                    f"{self._secrets_path}: top-level must be a mapping"
                )

        # Order matters: env interpolation runs on the raw tree FIRST
        # so secret values (high-entropy randoms, URL-encoded params,
        # whatever the deployer writes in the secrets file) are never
        # subject to string rewriting.  A literal ``${env:X}`` inside
        # a real token would otherwise crash the load with a spurious
        # UnresolvedRefError.  SecretRef placeholders in the raw tree
        # are preserved by resolve_env_interpolations and replaced in
        # the follow-up resolve_secret_refs pass.
        try:
            resolved = resolve_env_interpolations(raw_config)
            resolved = resolve_secret_refs(resolved, secrets)
        except UnresolvedRefError as exc:
            raise ConfigLoadError(
                f"{self._config_path}: {exc}"
            ) from exc

        return LoadedConfig(
            agent=resolved.get("agent", {}) or {},
            plugins=_extract_plugin_entries(resolved.get("plugins", {}) or {}),
            source_path=self._config_path,
            secrets_path=self._secrets_path,
        )


def _load_yaml_with_secret_tag(path: Path) -> Any:
    """Parse YAML file with ``!secret`` constructor registered.

    We subclass ``yaml.SafeLoader`` instead of patching the global one
    — keeps behavior predictable if any other code in the process
    also parses YAML.
    """
    import yaml

    class _HivemootLoader(yaml.SafeLoader):
        pass

    def _construct_secret(loader: yaml.SafeLoader, node: yaml.Node) -> SecretRef:
        if not isinstance(node, yaml.ScalarNode):
            raise ConfigLoadError(
                f"{path}:{node.start_mark.line + 1}: !secret expects a scalar "
                "(the secret name), got a complex node"
            )
        return SecretRef(name=loader.construct_scalar(node))

    _HivemootLoader.add_constructor("!secret", _construct_secret)

    try:
        return yaml.load(path.read_text(encoding="utf-8"), Loader=_HivemootLoader)
    except yaml.YAMLError as exc:
        raise ConfigLoadError(f"{path}: invalid YAML — {exc}") from exc


def _extract_plugin_entries(plugins_section: dict[str, Any]) -> list[PluginEntry]:
    """Turn the ``plugins:`` mapping into a list of PluginEntry.

    Each YAML key under ``plugins:`` is one plugin instance, keyed by
    plugin type name.  Multi-instance support (OTel-style
    ``type/name``) is NOT yet implemented — the engine would share one
    plugin object across instances, which breaks any plugin that
    keeps instance state (messaging sockets, github repo caches, …).
    We fail fast here so an operator can't mis-configure a fleet into
    silent state clobbering; reintroducing ``type/name`` is tracked as
    a follow-up that also needs engine changes to instantiate a fresh
    plugin per instance.
    """
    entries: list[PluginEntry] = []
    for instance_name, body in plugins_section.items():
        if not isinstance(instance_name, str):
            raise ConfigLoadError(
                f"plugins: key must be a string, got {type(instance_name).__name__}"
            )
        if "/" in instance_name:
            raise ConfigLoadError(
                f"plugins.{instance_name}: multi-instance keys "
                "(`type/name`) are not yet supported.  Use the bare "
                "type name as the key (e.g. `messaging:`)."
            )
        if not isinstance(body, dict):
            raise ConfigLoadError(
                f"plugins.{instance_name}: value must be a mapping, got "
                f"{type(body).__name__}"
            )
        if "type" in body and body["type"] != instance_name:
            raise ConfigLoadError(
                f"plugins.{instance_name}: explicit `type: {body['type']!r}` "
                f"does not match key.  Drop the `type` field — keys are "
                "the type name under ADR-003."
            )
        # Strip the type field from the raw config we hand the plugin
        # — it's metadata the plugin doesn't need in its Pydantic model.
        raw = {k: v for k, v in body.items() if k != "type"}
        entries.append(
            PluginEntry(
                instance_name=instance_name,
                type_name=instance_name,
                raw_config=raw,
            )
        )
    return entries
