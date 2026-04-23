"""Tests for the ADR-003 config layer (loader + manifest + resolver).

Covers the load-time paths the engine depends on before any plugin
validate() runs.  Each test is a standalone unittest case so the file
can be run with ``python3 cli/tests/test_config.py`` in CI (same as
the other script-validation tests).
"""

from __future__ import annotations

import os
import sys
import tempfile
import textwrap
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Config layer under test.
from hivemoot_agent.config import (
    ConfigLoadError,
    ConfigLoader,
    ManifestError,
    PluginManifest,
    SecretRef,
    resolve_env_interpolations,
    resolve_secret_refs,
)
from hivemoot_agent.config.loader import _extract_plugin_entries
from hivemoot_agent.config.resolver import UnresolvedRefError


# ── resolver: !secret ──────────────────────────────────────────────


class SecretResolutionTests(unittest.TestCase):

    def test_secret_ref_replaced_from_secrets_dict(self):
        node = {"token": SecretRef(name="gh_token"), "inner": {
            "pw": SecretRef(name="db_pw"),
        }}
        secrets = {"gh_token": "ghp_xyz", "db_pw": "hunter2"}
        resolved = resolve_secret_refs(node, secrets)
        self.assertEqual(resolved["token"], "ghp_xyz")
        self.assertEqual(resolved["inner"]["pw"], "hunter2")

    def test_missing_secret_raises_with_path_breadcrumb(self):
        node = {"plugins": {"messaging": {"bot_token_file": SecretRef(name="no_such")}}}
        with self.assertRaises(UnresolvedRefError) as ctx:
            resolve_secret_refs(node, secrets={})
        msg = str(ctx.exception)
        self.assertIn("plugins.messaging.bot_token_file", msg)
        self.assertIn("no_such", msg)

    def test_secret_ref_in_list_is_resolved(self):
        node = [SecretRef(name="a"), SecretRef(name="b")]
        resolved = resolve_secret_refs(node, {"a": "1", "b": "2"})
        self.assertEqual(resolved, ["1", "2"])


# ── resolver: ${env:VAR} ───────────────────────────────────────────


class EnvInterpolationTests(unittest.TestCase):

    def test_env_var_interpolated(self):
        os.environ["HMT_TEST_FOO"] = "hello"
        try:
            resolved = resolve_env_interpolations({"greet": "${env:HMT_TEST_FOO} world"})
        finally:
            del os.environ["HMT_TEST_FOO"]
        self.assertEqual(resolved["greet"], "hello world")

    def test_missing_env_var_raises_with_path(self):
        os.environ.pop("HMT_TEST_MISSING", None)
        with self.assertRaises(UnresolvedRefError) as ctx:
            resolve_env_interpolations(
                {"plugins": {"x": {"url": "${env:HMT_TEST_MISSING}"}}},
            )
        self.assertIn("plugins.x.url", str(ctx.exception))
        self.assertIn("HMT_TEST_MISSING", str(ctx.exception))

    def test_secret_ref_is_passed_through_untouched(self):
        """Env interpolation must not walk *into* a SecretRef — real
        tokens contain literal ${...} and we'd crash on bogus env vars."""
        node = {"token": SecretRef(name="real_secret_with_dollar_braces")}
        resolved = resolve_env_interpolations(node)
        self.assertIsInstance(resolved["token"], SecretRef)

    def test_multiple_substitutions_in_one_string(self):
        os.environ["HMT_HOST"] = "api.internal"
        os.environ["HMT_PORT"] = "8080"
        try:
            resolved = resolve_env_interpolations(
                {"url": "http://${env:HMT_HOST}:${env:HMT_PORT}/v1"},
            )
        finally:
            del os.environ["HMT_HOST"]
            del os.environ["HMT_PORT"]
        self.assertEqual(resolved["url"], "http://api.internal:8080/v1")


# ── resolver: interaction (B4 regression) ──────────────────────────


class EnvOrderingRegressionTests(unittest.TestCase):
    """Regression for dkjazz PR #595 finding B4.

    A real secret value containing a literal ``${env:...}`` substring
    must never be subject to env interpolation, even when env
    interpolation runs after secret resolution (the old ordering).
    """

    def test_secret_with_dollar_braces_survives_full_pipeline(self):
        raw = {"plugins": {"x": {"token": SecretRef(name="pw")}}}
        tricky = "abc${env:DOES_NOT_EXIST}def"
        # B4 fix: env interpolation runs FIRST on the raw tree (secret
        # ref survives), THEN secrets get swapped in.
        after_env = resolve_env_interpolations(raw)
        resolved = resolve_secret_refs(after_env, secrets={"pw": tricky})
        self.assertEqual(resolved["plugins"]["x"]["token"], tricky)


# ── loader: _extract_plugin_entries ────────────────────────────────


class ExtractPluginEntriesTests(unittest.TestCase):

    def test_single_instance_key_works(self):
        entries = _extract_plugin_entries({"messaging": {"platform": "telegram"}})
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].type_name, "messaging")
        self.assertEqual(entries[0].instance_name, "messaging")
        self.assertEqual(entries[0].raw_config, {"platform": "telegram"})

    def test_type_slash_name_rejected(self):
        with self.assertRaises(ConfigLoadError) as ctx:
            _extract_plugin_entries({"messaging/primary": {"x": 1}})
        self.assertIn("multi-instance", str(ctx.exception))

    def test_explicit_type_matching_key_is_accepted(self):
        entries = _extract_plugin_entries(
            {"messaging": {"type": "messaging", "platform": "telegram"}},
        )
        # ``type`` is stripped from the raw_config dict.
        self.assertNotIn("type", entries[0].raw_config)

    def test_explicit_type_mismatching_key_is_rejected(self):
        with self.assertRaises(ConfigLoadError) as ctx:
            _extract_plugin_entries(
                {"messaging": {"type": "not-messaging", "platform": "telegram"}},
            )
        self.assertIn("does not match key", str(ctx.exception))

    def test_non_mapping_body_rejected(self):
        with self.assertRaises(ConfigLoadError) as ctx:
            _extract_plugin_entries({"messaging": "not-a-dict"})
        self.assertIn("must be a mapping", str(ctx.exception))


# ── loader: ConfigLoader.load() integration ────────────────────────


class ConfigLoaderIntegrationTests(unittest.TestCase):

    def _loader(self, config: str, secrets: str | None = None) -> ConfigLoader:
        tmp = Path(tempfile.mkdtemp(prefix="hm-cfg-"))
        self.addCleanup(_rmtree, tmp)
        cfg = tmp / "hivemoot.yaml"
        cfg.write_text(textwrap.dedent(config))
        sec_path: Path | None = None
        if secrets is not None:
            sec_path = tmp / "hivemoot.secrets.yaml"
            sec_path.write_text(textwrap.dedent(secrets))
        return ConfigLoader(config_path=cfg, secrets_path=sec_path)

    def test_top_level_non_mapping_rejected(self):
        loader = self._loader("- one\n- two\n")
        with self.assertRaises(ConfigLoadError) as ctx:
            loader.load()
        self.assertIn("top-level must be a mapping", str(ctx.exception))

    def test_missing_file_rejected(self):
        with self.assertRaises(ConfigLoadError) as ctx:
            ConfigLoader(config_path=Path("/nonexistent/hivemoot.yaml")).load()
        self.assertIn("not found", str(ctx.exception))

    def test_secret_and_env_both_resolved(self):
        os.environ["HMT_CFG_STAGE"] = "prod"
        try:
            loader = self._loader(
                config="""
                plugins:
                  messaging:
                    platform: telegram
                    stage: ${env:HMT_CFG_STAGE}
                    bot_token_file: !secret tg
                """,
                secrets="""
                tg: /run/secrets/telegram_bot_token
                """,
            )
            loaded = loader.load()
        finally:
            del os.environ["HMT_CFG_STAGE"]
        self.assertEqual(len(loaded.plugins), 1)
        raw = loaded.plugins[0].raw_config
        self.assertEqual(raw["platform"], "telegram")
        self.assertEqual(raw["stage"], "prod")
        self.assertEqual(raw["bot_token_file"], "/run/secrets/telegram_bot_token")

    def test_secret_with_literal_dollar_braces_survives(self):
        """B4 regression — a secret value that looks like a template
        must not be interpolated."""
        loader = self._loader(
            config="""
            plugins:
              messaging:
                token: !secret literal_token
            """,
            secrets="""
            literal_token: "abc${env:NEVER_SET}def"
            """,
        )
        loaded = loader.load()
        self.assertEqual(
            loaded.plugins[0].raw_config["token"], "abc${env:NEVER_SET}def",
        )


# ── manifest: happy path + error paths ─────────────────────────────


class ManifestTests(unittest.TestCase):

    def _plugin_root(self, **files: str) -> Path:
        tmp = Path(tempfile.mkdtemp(prefix="hm-manifest-"))
        self.addCleanup(_rmtree, tmp)
        for name, body in files.items():
            (tmp / name).write_text(textwrap.dedent(body))
        return tmp

    def test_absolute_module_path_resolves(self):
        """The messaging plugin's manifest ships a fully-qualified path;
        loading it should pick up MessagingConfig without needing a
        plugin_module argument."""
        from hivemoot_agent.plugins_builtin.messaging.config import MessagingConfig
        root = Path(__file__).resolve().parent.parent / "hivemoot_agent" / "plugins_builtin" / "messaging"
        manifest = PluginManifest.from_path(root)
        self.assertIs(manifest.schema_class, MessagingConfig)

    def test_relative_schema_class_requires_plugin_module(self):
        root = self._plugin_root(**{
            "plugin.yaml": """
                name: test_plugin
                version: 0.0.1
                description: test
                schema_class: :WillNeverResolve
            """,
        })
        with self.assertRaises(ManifestError) as ctx:
            PluginManifest.from_path(root)  # no plugin_module
        self.assertIn("no plugin module was available", str(ctx.exception))

    def test_relative_schema_class_resolves_with_plugin_module(self):
        """External plugins loaded under a synthesized module name
        still reach their Pydantic schema via the ``config:Foo``
        shorthand."""
        import importlib.util

        root = self._plugin_root(**{
            "__init__.py": "def create_plugin():\n    return None\n",
            "config.py": (
                "from pydantic import BaseModel\n"
                "class MyConfig(BaseModel):\n"
                "    foo: str = 'bar'\n"
            ),
            "plugin.yaml": """
                name: my_ext
                version: 0.1.0
                description: external
                schema_class: config:MyConfig
            """,
        })

        # Simulate the synthesized module name _discover_external uses.
        mod_name = f"hivemoot_agent_external_my_ext_{uuid.uuid4().hex[:8]}"
        spec = importlib.util.spec_from_file_location(
            mod_name, root / "__init__.py",
            submodule_search_locations=[str(root)],
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        try:
            spec.loader.exec_module(mod)
            manifest = PluginManifest.from_path(root, plugin_module=mod)
            self.assertIsNotNone(manifest.schema_class)
            instance = manifest.validate_config({"foo": "hello"})
            self.assertEqual(instance.foo, "hello")
        finally:
            sys.modules.pop(mod_name, None)

    def test_unimportable_module_raises(self):
        root = self._plugin_root(**{
            "plugin.yaml": """
                name: test_plugin
                version: 0.0.1
                description: test
                schema_class: totally.bogus.package:Foo
            """,
        })
        with self.assertRaises(ManifestError) as ctx:
            PluginManifest.from_path(root)
        self.assertIn("failed to import", str(ctx.exception))

    def test_missing_required_fields_raises(self):
        root = self._plugin_root(**{
            "plugin.yaml": "description: no name here\n",
        })
        with self.assertRaises(ManifestError) as ctx:
            PluginManifest.from_path(root)
        self.assertIn("'name' and 'version' are required", str(ctx.exception))

    def test_missing_manifest_raises(self):
        root = Path(tempfile.mkdtemp(prefix="hm-manifest-"))
        self.addCleanup(_rmtree, root)
        with self.assertRaises(ManifestError) as ctx:
            PluginManifest.from_path(root)
        self.assertIn("missing plugin.yaml", str(ctx.exception))


# ── utilities ──────────────────────────────────────────────────────


def _rmtree(path: Path) -> None:
    """Recursive tree cleanup — plain shutil, kept local to dodge the
    unittest cleanup registry ordering issues some platforms hit."""
    import shutil
    shutil.rmtree(path, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
