"""Plugin config layer — manifest + YAML + Pydantic.

Replaces the pre-ADR-003 model where every plugin read flat env vars.
Now plugins declare their config schema in a Pydantic model, ship a
small ``plugin.yaml`` manifest pointing at that schema, and receive a
fully-validated typed instance at ``setup()`` time.

Layout:

  config/
  ├── __init__.py    # re-exports the public API
  ├── loader.py      # ConfigLoader — parse YAML, resolve tags, validate
  ├── manifest.py    # PluginManifest — load plugin.yaml + schema class
  └── resolver.py    # !secret and ${env:VAR} resolution

The operator writes two files (per-agent):

  hivemoot.yaml           # activation + config values
  hivemoot.secrets.yaml   # secret values referenced by !secret tags

Each plugin ships:

  plugins_builtin/<name>/plugin.yaml    # manifest (name, version, schema_class)
  plugins_builtin/<name>/__init__.py    # Pydantic <Name>Config + plugin class

See ``docs/adr/003-plugin-config.md`` for the design rationale.
"""

from __future__ import annotations

from hivemoot_agent.config.base import StrictPluginConfig
from hivemoot_agent.config.loader import ConfigLoader, ConfigLoadError
from hivemoot_agent.config.manifest import PluginManifest, ManifestError
from hivemoot_agent.config.resolver import (
    SecretRef,
    resolve_env_interpolations,
    resolve_secret_refs,
)

__all__ = [
    "ConfigLoader",
    "ConfigLoadError",
    "PluginManifest",
    "ManifestError",
    "SecretRef",
    "StrictPluginConfig",
    "resolve_env_interpolations",
    "resolve_secret_refs",
]
