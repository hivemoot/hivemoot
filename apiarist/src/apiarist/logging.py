"""Structured JSON logging with token-shape redaction.

Built on structlog. Every log event passes through a redaction processor
that replaces well-known secret patterns with ``[REDACTED]`` before JSON
serialization, then renders to stderr (which systemd captures into the
journal under the `apiarist.service` unit).

DESIGN.md §10 lists redaction as a mitigation for "tokens leaking into
logs/journal." The pattern set is aligned with the existing module at
``agent/cli/hivemoot_agent/plugins_builtin/hivemoot/sanitize.py`` —
that module is the authoritative reference for the secret shapes the
hivemoot stack already cares about. apiarist-specific additions here:
GitHub fine-grained PATs (``github_pat_*``) and the apiarist agent
token prefix (``hm_*``).

Redaction is recursive over the structlog event dict: nested dicts /
lists / tuples are walked and string leaves are pattern-checked.
Non-string values pass through unchanged so structured fields like
counts / durations / booleans are not mangled.
"""

from __future__ import annotations

import logging
import re
import sys
from typing import Any

import structlog

_REDACTED = "[REDACTED]"

# Order matters: more-specific patterns run before more-generic ones, so
# replacements don't strip the structural hint a later pattern would key
# off (e.g., the generic ``token=`` rule would otherwise eat the
# ``Bearer`` keyword that the first rule preserves for diagnostics).
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # Bearer / Authorization headers echoed in error text.
    (re.compile(r"Bearer\s+[A-Za-z0-9._\-]+", re.IGNORECASE), f"Bearer {_REDACTED}"),
    # Anthropic-prefixed (sk-ant-) MUST run before the generic sk- rule
    # because both regexes match the same prefix.
    (re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}\b"), f"sk-ant-{_REDACTED}"),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}\b"), f"sk-{_REDACTED}"),
    # GitHub classic + installation tokens (ghp/ghs/gho/ghu/ghr).
    (re.compile(r"\bgh[psuor]_[A-Za-z0-9]{20,}\b"), f"gh*_{_REDACTED}"),
    # GitHub fine-grained PATs (apiarist-specific addition vs the
    # agent/cli sanitize patterns; fine-grained PATs are how the
    # foxstoria-style per-repo identities are issued).
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), f"github_pat_{_REDACTED}"),
    # Apiarist agent tokens (hm_ prefix). The current
    # apiary.secrets.yaml `health_token` is a 64-char hex without the
    # hm_ prefix — that bare-hex shape is intentionally NOT redacted
    # here because it would match commit SHAs and other innocuous hex
    # blobs. Operators rotating tokens to the prefixed form get
    # redaction; the bare-hex value relies on file permissions
    # (chmod 640) for protection.
    (re.compile(r"\bhm_[A-Za-z0-9]{16,}\b"), f"hm_{_REDACTED}"),
    # Generic ``token=<val>`` / ``api_key: <val>`` / ``api-key: "<val>"``
    # in URL query strings, YAML/JSON config snippets, or inline error
    # text. Optional surrounding quotes so ``api_key: "sk_..."`` scrubs
    # the value without leaving the quoted secret intact.
    (
        re.compile(r"(?i)\b(token|api[_-]?key)\s*[=:]\s*[\"']?[A-Za-z0-9._\-]+[\"']?"),
        rf"\1={_REDACTED}",
    ),
)


def redact_string(text: str) -> str:
    """Return ``text`` with all known secret patterns replaced.

    Empty / falsy strings pass through unchanged so callers can feed
    optional values without a guard.
    """
    if not text:
        return text
    out = text
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def _redact_value(value: Any) -> Any:
    """Recursively walk a value, redacting strings, leaving other types alone.

    Walks dict / list / tuple containers; everything else (int, bool,
    None, custom objects) passes through untouched. Tuple identity is
    preserved by re-wrapping with the original type.
    """
    if isinstance(value, str):
        return redact_string(value)
    if isinstance(value, dict):
        return {k: _redact_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(v) for v in value)
    return value


def redact_processor(
    logger: Any, method_name: str, event_dict: structlog.types.EventDict
) -> structlog.types.EventDict:
    """structlog processor: redact token-shaped strings in every event value.

    Runs after all enrichment processors (level, timestamp, exc_info)
    so any token that snuck into a stack trace or context dict gets
    scrubbed too. Runs before the JSON renderer so the on-wire bytes
    are already redacted.
    """
    return {k: _redact_value(v) for k, v in event_dict.items()}


def configure_logging(level: str = "info") -> None:
    """Configure structlog for JSON output to stderr with redaction enabled.

    Idempotent — safe to call from tests or from CLI re-entry.
    """
    log_level = _level_to_int(level)

    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.format_exc_info,
            redact_processor,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        logger_factory=structlog.WriteLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=False,  # tests reconfigure between cases
    )


def _level_to_int(level: str) -> int:
    return getattr(logging, level.upper(), logging.INFO)
