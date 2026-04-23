"""Plugin system — discovery, loading, and registry."""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
import uuid
from pathlib import Path

from hivemoot_agent.config.manifest import ManifestError, PluginManifest
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
        self._manifests: dict[str, PluginManifest] = {}

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

    def _instantiate(self, mod: object, entry: Path) -> Plugin | None:
        plugin_factory = getattr(mod, "create_plugin", None)
        if plugin_factory is None:
            return None
        plugin = plugin_factory()
        try:
            setattr(plugin, "__hivemoot_plugin_root__", str(entry))
        except Exception:
            pass
        # Load plugin.yaml manifest if present.  Under ADR-003 plugins
        # SHOULD ship a manifest, but during the incremental migration
        # we tolerate missing manifests — such plugins fall back to the
        # legacy env-var-based config path.  The engine's _resolve_plugins
        # does the same dual-path handling.
        if (entry / "plugin.yaml").is_file():
            try:
                manifest = PluginManifest.from_path(entry, plugin_module=mod)
                self._manifests[plugin.name] = manifest
            except ManifestError as exc:
                print(
                    f"warning: plugin '{plugin.name}' has a malformed manifest "
                    f"and will fall back to legacy env-var config: {exc}",
                    file=sys.stderr,
                )
        return plugin

    def source_of(self, name: str) -> str:
        """Return 'builtin' or 'external' for a registered plugin name."""
        return self._sources.get(name, "")

    def manifest_for(self, name: str) -> PluginManifest | None:
        """Return the parsed plugin.yaml manifest for ``name``, or None."""
        return self._manifests.get(name)

    def register(
        self,
        plugin: Plugin,
        source: str = "builtin",
        manifest: PluginManifest | None = None,
    ) -> None:
        """Manually register a plugin instance (used by tests)."""
        self._plugins[plugin.name] = plugin
        self._sources[plugin.name] = source
        if manifest is not None:
            self._manifests[plugin.name] = manifest

    def get(self, name: str) -> Plugin | None:
        return self._plugins.get(name)

    def all(self) -> dict[str, Plugin]:
        return dict(self._plugins)

    def configure(self, name: str, config: PluginConfig) -> None:
        """Store a fully-resolved PluginConfig for later retrieval.

        Under ADR-003 the engine builds PluginConfig objects from the
        loaded hivemoot.yaml (with typed= populated from the Pydantic
        validated instance) and parks them here for each plugin to
        read during setup / system_prompt / trigger.
        """
        self._configs[name] = config

    def configured_names(self) -> list[str]:
        """Return the names of plugins that have been ``configure()``-d so far,
        in insertion order.

        Used by plugins whose validation depends on activation/setup
        order (e.g. ``hivemoot-github`` needs ``github`` configured
        before it so its repos are cloned by the time setup runs).
        The engine calls ``configure()`` then ``validate()`` for each
        YAML entry in order, so when a later plugin's validate runs it
        can ask "was my dependency configured before me?" via this
        method.

        Replaces the pre-ADR-003 pattern of reading ``AGENT_PLUGINS``
        env var to learn the activation list — under ADR-003 the YAML
        order IS the activation order, full stop.
        """
        return list(self._configs.keys())

    def config_for(self, name: str) -> PluginConfig:
        """Return the stored config for ``name``.

        Under ADR-003 every activated plugin MUST have been
        ``configure()``-d by the engine before any consumer reaches
        here.  Returning a typed-None fallback silently produces
        PluginConfigs that crash migrated plugins with cryptic
        AttributeError on ``config.typed.<field>``; CLAUDE.md's
        fail-closed-not-open guidance is explicit on this.

        Test harnesses that deliberately skip configure() should call
        ``config_for_or_none`` and assert the None result, or install
        a stub config via ``configure()``.
        """
        configured = self._configs.get(name)
        if configured is None:
            raise KeyError(
                f"registry.config_for('{name}') called without a prior "
                "configure().  Migrated plugins need a typed config; "
                "this indicates either (a) a plugin ordering bug where "
                "a consumer runs before ConfigLoader populates the "
                "target, or (b) a test harness that forgot to call "
                "configure() / should use config_for_or_none() instead."
            )
        return configured

    def config_for_or_none(self, name: str) -> PluginConfig | None:
        """Like ``config_for`` but returns None when unconfigured.

        For tests that deliberately inspect the unconfigured state
        (plugin discovery without a YAML, registry lifecycle tests).
        Production code should always use ``config_for``.
        """
        return self._configs.get(name)

    def validate(self, name: str) -> list[str]:
        """Validate a plugin's config.  Returns list of errors."""
        plugin = self.get(name)
        if plugin is None:
            return [f"Plugin '{name}' not found"]
        configured = self._configs.get(name)
        if configured is None:
            return [
                f"Plugin '{name}' has no stored config; call configure() "
                "before validate() (engine does this automatically)."
            ]
        return plugin.validate(configured)


# Global registry instance.
registry = PluginRegistry()
