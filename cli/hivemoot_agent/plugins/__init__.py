"""Plugin system — discovery, loading, and registry."""

from __future__ import annotations

import importlib
import os
import sys
from pathlib import Path

from hivemoot_agent.plugins.interfaces import Plugin, PluginConfig


class PluginRegistry:
    """Discovers and manages plugins."""

    def __init__(self) -> None:
        self._plugins: dict[str, Plugin] = {}
        self._configs: dict[str, PluginConfig] = {}

    def discover(self, plugins_dir: Path | None = None) -> None:
        """Scan the built-in plugins directory and register found plugins."""
        if plugins_dir is None:
            plugins_dir = Path(__file__).parent.parent / "plugins_builtin"

        if not plugins_dir.is_dir():
            return

        for entry in sorted(plugins_dir.iterdir()):
            if not entry.is_dir() or entry.name.startswith("_"):
                continue
            init_file = entry / "__init__.py"
            if not init_file.exists():
                continue
            try:
                mod = importlib.import_module(f"hivemoot_agent.plugins_builtin.{entry.name}")
                plugin_factory = getattr(mod, "create_plugin", None)
                if plugin_factory is None:
                    continue
                plugin = plugin_factory()
                self._plugins[plugin.name] = plugin
            except Exception as exc:
                print(
                    f"warning: failed to load plugin '{entry.name}': {exc}",
                    file=sys.stderr,
                )

    def register(self, plugin: Plugin) -> None:
        """Manually register a plugin instance."""
        self._plugins[plugin.name] = plugin

    def get(self, name: str) -> Plugin | None:
        return self._plugins.get(name)

    def all(self) -> dict[str, Plugin]:
        return dict(self._plugins)

    def configure(self, name: str, config: PluginConfig) -> None:
        self._configs[name] = config

    def config_for(self, name: str) -> PluginConfig:
        env_settings = dict(os.environ)
        configured = self._configs.get(name)
        if configured is None:
            return PluginConfig(name=name, settings=env_settings)

        merged_settings = dict(env_settings)
        merged_settings.update(configured.settings)
        return PluginConfig(
            name=configured.name,
            enabled=configured.enabled,
            settings=merged_settings,
        )

    def validate(self, name: str) -> list[str]:
        """Validate a plugin's config.  Returns list of errors."""
        plugin = self.get(name)
        if plugin is None:
            return [f"Plugin '{name}' not found"]
        config = self.config_for(name)
        return plugin.validate(config)


# Global registry instance.
registry = PluginRegistry()
