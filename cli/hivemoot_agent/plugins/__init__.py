"""Plugin system — discovery, loading, and registry."""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
import uuid
from pathlib import Path

from hivemoot_agent.plugins.interfaces import Plugin, PluginConfig

# Fixed external mount point for deployer-supplied custom plugins.
# Mirrors the skills convention (engine.py:_EXTERNAL_SKILLS_DIR).  A
# deployer ships custom plugins by mounting a host directory here;
# each subdirectory containing __init__.py with create_plugin() is
# loaded.  The path is *outside* the Python package on purpose —
# bind-mounting over the package's own plugins_builtin/ would shadow
# image-shipped plugins and couple deployers to internal layout.
_EXTERNAL_PLUGINS_DIR = Path("/opt/hivemoot-agent/plugins")


class PluginRegistry:
    """Discovers and manages plugins."""

    def __init__(self) -> None:
        self._plugins: dict[str, Plugin] = {}
        self._configs: dict[str, PluginConfig] = {}
        self._sources: dict[str, str] = {}

    def discover(
        self,
        plugins_dir: Path | None = None,
        external_dir: Path | None = None,
    ) -> None:
        """Discover plugins from built-in and external locations.

        Built-in plugins ship inside the runtime package at
        ``cli/hivemoot_agent/plugins_builtin/``.  External plugins are
        mounted by the deployer at ``/opt/hivemoot-agent/plugins/``
        (overridable for tests via ``external_dir``).

        Collision policy: built-ins win.  An external plugin whose
        ``name`` matches a built-in is rejected with a warning so
        deployers can't accidentally shadow runtime behaviour.  Custom
        plugins should use a fleet-prefixed name (e.g.
        ``apiary-spitvste``) to stay collision-free.
        """
        if plugins_dir is None:
            plugins_dir = Path(__file__).parent.parent / "plugins_builtin"

        self._discover_builtin(plugins_dir)

        ext = external_dir if external_dir is not None else _EXTERNAL_PLUGINS_DIR
        if ext.is_dir():
            self._discover_external(ext)

    def _discover_builtin(self, plugins_dir: Path) -> None:
        if not plugins_dir.is_dir():
            return

        for entry in sorted(plugins_dir.iterdir()):
            if not entry.is_dir() or entry.name.startswith("_"):
                continue
            if not (entry / "__init__.py").exists():
                continue
            try:
                mod = importlib.import_module(
                    f"hivemoot_agent.plugins_builtin.{entry.name}"
                )
                plugin = self._instantiate(mod, entry)
                if plugin is None:
                    continue
                self._plugins[plugin.name] = plugin
                self._sources[plugin.name] = "builtin"
            except Exception as exc:
                print(
                    f"warning: failed to load plugin '{entry.name}': {exc}",
                    file=sys.stderr,
                )

    def _discover_external(self, plugins_dir: Path) -> None:
        for entry in sorted(plugins_dir.iterdir()):
            if not entry.is_dir() or entry.name.startswith("_"):
                continue
            init_file = entry / "__init__.py"
            if not init_file.exists():
                continue
            try:
                # Synthesize a unique module name so two external dirs
                # with the same package name (e.g. dev + prod stages
                # mounted side-by-side in tests) don't collide in
                # sys.modules.
                mod_name = f"hivemoot_agent_external_{entry.name}_{uuid.uuid4().hex[:8]}"
                spec = importlib.util.spec_from_file_location(
                    mod_name, init_file, submodule_search_locations=[str(entry)]
                )
                if spec is None or spec.loader is None:
                    continue
                mod = importlib.util.module_from_spec(spec)
                sys.modules[mod_name] = mod
                spec.loader.exec_module(mod)
                plugin = self._instantiate(mod, entry)
                if plugin is None:
                    continue
                if plugin.name in self._plugins and self._sources.get(plugin.name) == "builtin":
                    print(
                        f"warning: external plugin '{plugin.name}' from "
                        f"{entry} shadows a built-in; ignored.  "
                        f"Rename with a fleet prefix (e.g. "
                        f"'<fleet>-{plugin.name}') to load it.",
                        file=sys.stderr,
                    )
                    continue
                self._plugins[plugin.name] = plugin
                self._sources[plugin.name] = "external"
            except Exception as exc:
                print(
                    f"warning: failed to load external plugin '{entry.name}' "
                    f"from {entry}: {exc}",
                    file=sys.stderr,
                )

    @staticmethod
    def _instantiate(mod: object, entry: Path) -> Plugin | None:
        plugin_factory = getattr(mod, "create_plugin", None)
        if plugin_factory is None:
            return None
        plugin = plugin_factory()
        try:
            setattr(plugin, "__hivemoot_plugin_root__", str(entry))
        except Exception:
            pass
        return plugin

    def source_of(self, name: str) -> str:
        """Return 'builtin' or 'external' for a registered plugin name."""
        return self._sources.get(name, "")

    def register(self, plugin: Plugin, source: str = "builtin") -> None:
        """Manually register a plugin instance."""
        self._plugins[plugin.name] = plugin
        self._sources[plugin.name] = source

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
