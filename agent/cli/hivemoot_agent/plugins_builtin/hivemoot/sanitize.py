"""Redact well-known secret patterns from outbound diagnostic strings.

The ``error`` field posted to ``/api/agent-health`` (and the tasks
``post_fail`` ``error`` field) is a diagnostic channel — it must NOT
be used as a secret transport.  The agent's final message on failure
can contain env values, tool-output fragments, or short tokens the
model happened to emit.  We scrub the obvious patterns before the
string leaves the process.

This is belt-and-braces — the contract caps ``error`` at 256 chars,
but a short token at the head of the response would still fit.
Patterns covered are deliberately narrow to avoid clobbering
legitimate error text; new patterns added here MUST be tested.
"""

from __future__ import annotations

import re


_REDACTED = "[REDACTED]"


# Each pattern captures the secret-bearing segment and is replaced
# with a labelled redaction so operators can still tell *what* was
# scrubbed when debugging.  Order matters: more-specific patterns
# (``Bearer <tok>``) run before generic ones (``token=<value>``).
#
# ``Authorization`` deliberately excluded from the generic kv
# pattern — ``Authorization: Bearer <tok>`` is already handled by
# the Bearer rule above, and matching it generically would swallow
# the ``Bearer`` literal after the first rule fires (turning
# ``Bearer [REDACTED]`` into ``[REDACTED]`` and losing the hint
# about what kind of secret leaked).
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # Bearer / Authorization headers echoed in error text.
    (re.compile(r"Bearer\s+[A-Za-z0-9._\-]+", re.IGNORECASE),
     f"Bearer {_REDACTED}"),
    # Anthropic API keys are also OpenAI-style ``sk-`` prefixed, so
    # run the more-specific sk-ant- rule before the generic sk-.
    (re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}\b"),
     f"sk-ant-{_REDACTED}"),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}\b"), f"sk-{_REDACTED}"),
    # GitHub tokens (ghp_/ghs_/gho_/ghu_/ghr_).
    (re.compile(r"\bgh[psuor]_[A-Za-z0-9]{20,}\b"), f"gh*_{_REDACTED}"),
    # Generic ``token=<val>`` / ``api_key: <val>`` / ``api-key: "<val>"``
    # in URL query, YAML/JSON config, or inline error text.  Optional
    # surrounding quotes so ``api_key: "sk_..."`` scrubs the value
    # without leaving the quoted secret intact.
    (re.compile(
        r"(?i)\b(token|api[_-]?key)\s*[=:]\s*[\"']?[A-Za-z0-9._\-]+[\"']?",
     ), rf"\1={_REDACTED}"),
)


def redact_secrets(text: str) -> str:
    """Return ``text`` with known secret patterns replaced.

    Empty / non-string input passes through unchanged so callers can
    feed ``result.response or ""`` without a guard.
    """
    if not text:
        return text
    out = text
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out
