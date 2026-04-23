"""Secret + env-var resolution for the plugin config layer.

Two tag families:

  !secret <name>       → look up ``<name>`` in hivemoot.secrets.yaml
  ${env:VAR}           → inline substitution from os.environ at load time

Both resolve recursively through nested dicts / lists so a deeply-
nested value like ``plugins.messaging.bot_token_file`` can use
``!secret telegram_bot_token`` and get the same treatment as a
top-level field.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any


# ${env:VAR} → os.environ["VAR"].  The pattern enforces VAR looks
# like a POSIX env var name so we don't accidentally grab
# ${other:stuff} meant for future escape syntax.
_ENV_VAR_PATTERN = re.compile(r"\$\{env:([A-Z_][A-Z0-9_]*)\}")


@dataclass(frozen=True)
class SecretRef:
    """Placeholder returned by the PyYAML ``!secret`` constructor.

    The loader walks the parsed tree and swaps each SecretRef for the
    value found in the secrets file.  Using a dedicated type (not a
    raw string) lets us fail loudly if a secret reference survives
    into the validated config.
    """

    name: str


class UnresolvedRefError(Exception):
    """Raised when a ``!secret`` or ``${env:VAR}`` can't be resolved.

    The message includes the JSON-path-like breadcrumb to the field
    so the operator can find the offending line in their YAML
    without grep-guessing.
    """


def resolve_secret_refs(
    node: Any,
    secrets: dict[str, Any],
    path: str = "",
) -> Any:
    """Walk ``node`` and replace ``SecretRef`` instances with values from
    ``secrets``.  Unresolved refs raise ``UnresolvedRefError`` with the
    config path breadcrumb for actionable debugging.
    """
    if isinstance(node, SecretRef):
        if node.name not in secrets:
            raise UnresolvedRefError(
                f"{path}: !secret '{node.name}' not found in secrets file.  "
                f"Available keys: {sorted(secrets.keys())}"
            )
        return secrets[node.name]
    if isinstance(node, dict):
        return {
            k: resolve_secret_refs(v, secrets, _join_path(path, str(k)))
            for k, v in node.items()
        }
    if isinstance(node, list):
        return [
            resolve_secret_refs(v, secrets, f"{path}[{i}]")
            for i, v in enumerate(node)
        ]
    return node


def resolve_env_interpolations(node: Any, path: str = "") -> Any:
    """Walk ``node`` and substitute ``${env:VAR}`` occurrences in strings.

    This runs on the RAW parsed tree — BEFORE secret resolution —
    so secret values are never subject to string rewriting.  Real
    tokens and passwords can legitimately contain literal ``${...}``
    sequences (high-entropy randoms, URL-encoded parameters, etc.),
    and interpolating over a resolved secret would crash the loader
    with a spurious UnresolvedRefError when the substring happens to
    look like a template.

    ``SecretRef`` nodes are skipped here; they are opaque placeholders
    replaced in the follow-up ``resolve_secret_refs()`` pass.  Strings
    that appear elsewhere in the raw YAML remain eligible for
    interpolation as usual.

    Unresolved env vars raise ``UnresolvedRefError`` with the path
    breadcrumb + the unset variable name.
    """
    if isinstance(node, SecretRef):
        return node
    if isinstance(node, str):
        return _substitute_env_in_string(node, path)
    if isinstance(node, dict):
        return {
            k: resolve_env_interpolations(v, _join_path(path, str(k)))
            for k, v in node.items()
        }
    if isinstance(node, list):
        return [
            resolve_env_interpolations(v, f"{path}[{i}]")
            for i, v in enumerate(node)
        ]
    return node


def _substitute_env_in_string(s: str, path: str) -> str:
    """Replace every ``${env:VAR}`` in ``s`` with os.environ["VAR"].

    All substitutions happen in one pass; a value like
    ``http://${env:HOST}:${env:PORT}/api`` resolves both.  Any
    unresolved variable raises with the path + name so the operator
    gets an unambiguous pointer.
    """

    def replace(match: re.Match) -> str:
        name = match.group(1)
        if name not in os.environ:
            raise UnresolvedRefError(
                f"{path}: ${{env:{name}}} references environment variable "
                f"'{name}' but it is not set."
            )
        return os.environ[name]

    return _ENV_VAR_PATTERN.sub(replace, s)


def _join_path(prefix: str, key: str) -> str:
    if not prefix:
        return key
    return f"{prefix}.{key}"
