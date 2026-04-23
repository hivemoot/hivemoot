"""Plugin manifest loader.

Every plugin ships a ``plugin.yaml`` in its directory:

    name: messaging
    version: 0.3.0
    description: Chat messaging ...
    schema_class: hivemoot_agent.plugins_builtin.messaging:MessagingConfig

The ``schema_class`` field points at a Pydantic ``BaseModel`` subclass
(``module.path:ClassName``).  The loader imports it and returns it
alongside the manifest metadata; the engine then uses it to validate
the plugin's slice of ``hivemoot.yaml``.

We intentionally keep the manifest small — three fields are enough.
All config shape lives in the Pydantic class where it benefits from
real Python typing, IDE support, and the standard ``model_json_schema``
export path for generating JSON Schema documents editors consume.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ManifestError(Exception):
    """Raised when a plugin manifest is malformed or its schema class
    cannot be imported.  Message always names the plugin directory so
    operators can locate the broken plugin without grep-guessing.
    """


@dataclass
class PluginManifest:
    """Loaded plugin.yaml metadata + resolved schema class."""

    name: str
    version: str
    description: str
    schema_class: type | None  # pydantic.BaseModel subclass, None = no config
    plugin_root: Path

    @classmethod
    def from_path(
        cls,
        plugin_root: Path,
        *,
        plugin_module: Any = None,
    ) -> PluginManifest:
        """Load plugin.yaml from ``plugin_root / 'plugin.yaml'``.

        ``plugin_module`` is the already-imported plugin package object.
        When provided, ``schema_class`` may use the shorthand
        ``:ClassName`` to mean "resolve against the plugin's own
        module".  This is how external plugins (loaded under a
        synthesized ``hivemoot_agent_external_<name>_<uuid>`` module
        name that can't be typed into plugin.yaml) reach their own
        schema class.

        Raises ``ManifestError`` on:
          * missing or unreadable manifest file
          * missing required fields (name, version)
          * schema_class that doesn't import or isn't a BaseModel subclass
        """
        import yaml  # lazy — PyYAML isn't on PATH during ``--help``

        manifest_path = plugin_root / "plugin.yaml"
        if not manifest_path.is_file():
            raise ManifestError(
                f"{plugin_root}: missing plugin.yaml manifest.  Every plugin "
                "must ship a manifest under ADR-003; see "
                "docs/adr/003-plugin-config.md for the minimum required shape."
            )

        try:
            data = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            raise ManifestError(f"{manifest_path}: invalid YAML — {exc}") from exc

        if not isinstance(data, dict):
            raise ManifestError(
                f"{manifest_path}: top-level must be a mapping, got {type(data).__name__}"
            )

        name = data.get("name", "")
        version = data.get("version", "")
        description = data.get("description", "")
        schema_class_ref = data.get("schema_class", "")

        if not name or not version:
            raise ManifestError(
                f"{manifest_path}: 'name' and 'version' are required"
            )

        schema_class: type | None = None
        if schema_class_ref:
            schema_class = _import_schema_class(
                schema_class_ref, manifest_path, plugin_module=plugin_module,
            )

        return cls(
            name=name,
            version=version,
            description=description,
            schema_class=schema_class,
            plugin_root=plugin_root,
        )

    def validate_config(self, raw: dict[str, Any]) -> Any:
        """Construct the plugin's typed config model from a raw dict.

        Returns the Pydantic instance.  Raises the underlying
        ``pydantic.ValidationError`` so the caller can format it with
        the plugin's name prefixed.

        Plugins with no schema_class (pure trigger plugins that don't
        take config) get an empty placeholder — the caller gets back
        ``None`` and knows to skip typed access.
        """
        if self.schema_class is None:
            return None
        return self.schema_class(**raw)


def _import_schema_class(
    ref: str,
    manifest_path: Path,
    *,
    plugin_module: Any = None,
) -> type:
    """Parse ``module.path:ClassName`` → import module → return class.

    Also accepts the shorthand forms ``:ClassName`` and
    ``submodule:ClassName`` for external plugins loaded under a
    synthesized module name.  In those cases ``plugin_module`` must be
    the plugin's already-imported package object; the submodule part
    is resolved relative to it (empty module part = the package
    itself, a submodule = ``plugin_module.__name__ + '.' + submodule``).

    Validates the resolved object is a Pydantic ``BaseModel`` subclass
    (duck-typed via the ``model_fields`` attr to avoid a hard Pydantic
    import at module-import time — helpful for error paths that run
    before pip has installed deps).
    """
    if ":" not in ref:
        raise ManifestError(
            f"{manifest_path}: schema_class must use 'module.path:ClassName' "
            f"or ':ClassName' (relative) format, got {ref!r}"
        )
    module_path, _, class_name = ref.partition(":")

    resolved_module: Any
    if not module_path:
        # Relative shorthand ``:ClassName`` — use the plugin package itself.
        if plugin_module is None:
            raise ManifestError(
                f"{manifest_path}: schema_class {ref!r} uses the relative "
                "form but no plugin module was available to resolve against"
            )
        resolved_module = plugin_module
    elif plugin_module is not None and _is_relative_submodule(module_path):
        # ``config:ClassName`` under an external plugin whose real module
        # name is synthesized (hivemoot_agent_external_<name>_<uuid>).
        # Resolve ``config`` as a submodule of the plugin package.
        submodule_name = f"{plugin_module.__name__}.{module_path}"
        try:
            resolved_module = importlib.import_module(submodule_name)
        except ImportError as exc:
            raise ManifestError(
                f"{manifest_path}: schema_class submodule {module_path!r} "
                f"(tried {submodule_name!r}) failed to import — {exc}"
            ) from exc
    else:
        try:
            resolved_module = importlib.import_module(module_path)
        except ImportError as exc:
            raise ManifestError(
                f"{manifest_path}: schema_class module {module_path!r} failed to "
                f"import — {exc}"
            ) from exc

    cls = getattr(resolved_module, class_name, None)
    if cls is None:
        raise ManifestError(
            f"{manifest_path}: schema_class {ref} not found in "
            f"{getattr(resolved_module, '__name__', '?')!r}"
        )
    if not hasattr(cls, "model_fields"):
        # Duck-type rather than isinstance — dodges a circular import
        # if the schema file itself fails to load.
        raise ManifestError(
            f"{manifest_path}: schema_class {ref} is not a Pydantic "
            "BaseModel subclass (no model_fields attribute)"
        )
    return cls


def _is_relative_submodule(module_path: str) -> bool:
    """Heuristic: single-segment module paths are treated as relative.

    External plugins can't reference their package by name (it's a
    synthesized UUID-suffixed string), so ``config:Foo`` must mean
    ``<plugin_pkg>.config.Foo``.  A dotted name like ``pkg.sub`` is
    always treated as absolute — it's unambiguous and the absolute
    form must still work for built-in plugins shipped as a known path.
    """
    return "." not in module_path
