"""Tests for apiarist.logging — token-shape redaction.

DESIGN.md §10 mitigation: tokens MUST never reach the journal. These
tests pin every redaction pattern + the recursive walk so future
edits to the pattern set don't silently regress.
"""

from __future__ import annotations

import io
import json

import pytest
import structlog

from apiarist.logging import (
    _redact_value,
    configure_logging,
    redact_processor,
    redact_string,
)

# ---------------------------------------------------------------------------
# String-level redaction: one test per token shape so failures point at the
# specific pattern that broke.
# ---------------------------------------------------------------------------


def test_empty_string_passes_through() -> None:
    assert redact_string("") == ""


def test_plain_string_unchanged() -> None:
    text = "Task failed: expected commit message, got nothing"
    assert redact_string(text) == text


def test_bearer_header_redacted() -> None:
    out = redact_string("curl: Authorization: Bearer ghp_xxxxxxxxxxxxxxxxxxxx rejected")
    assert "ghp_xxxx" not in out
    assert "Bearer [REDACTED]" in out


def test_bearer_case_insensitive() -> None:
    out = redact_string("BEARER ghs_aaaaaaaaaaaaaaaaaaaa")
    assert "ghs_aaaa" not in out


def test_anthropic_oauth_token_redacted() -> None:
    out = redact_string("api error: sk-ant-oat01_abcdefghijklmnop rejected")
    assert "sk-ant-oat01_abcdefghijklmnop" not in out
    assert "sk-ant-[REDACTED]" in out


def test_openai_style_key_redacted() -> None:
    out = redact_string("got 401 from sk-abcdef1234567890ABCDEF12 — check creds")
    assert "abcdef1234567890ABCDEF12" not in out
    assert "sk-[REDACTED]" in out


@pytest.mark.parametrize("prefix", ["ghp_", "ghs_", "gho_", "ghu_", "ghr_"])
def test_github_token_prefixes_redacted(prefix: str) -> None:
    token = f"{prefix}ABCDEFGHIJKLMNOPQRSTUVWXYZ12"
    out = redact_string(f"git push failed: bad credentials {token}")
    assert token not in out
    assert "[REDACTED]" in out


def test_github_fine_grained_pat_redacted() -> None:
    token = "github_pat_11ABCDEFG0_xxxxxxxxxxxxxxxxxxxxxxx"
    out = redact_string(f"401 Unauthorized: {token}")
    assert token not in out
    assert "github_pat_[REDACTED]" in out


def test_apiarist_hm_token_redacted() -> None:
    token = "hm_abcdefghij1234567890klmnop"
    out = redact_string(f"loaded agent token {token} from secrets.yaml")
    assert token not in out
    assert "hm_[REDACTED]" in out


def test_token_query_param_redacted() -> None:
    out = redact_string("POST failed: url=https://api.example/x?token=abcdef1234567890 rejected")
    assert "token=abcdef1234567890" not in out
    assert "[REDACTED]" in out


def test_api_key_field_redacted() -> None:
    out = redact_string('config error: api_key: "sk_abcd1234567890ABCD" malformed')
    assert "sk_abcd1234567890ABCD" not in out
    assert "[REDACTED]" in out


def test_bare_hex_not_redacted() -> None:
    # Avoid false positives on commit SHAs — DESIGN.md notes this is
    # intentional; bare-hex agent tokens rely on file permissions,
    # not log redaction.
    sha = "a1b2c3d4e5f60708090a0b0c0d0e0f1011121314"
    text = f"commit {sha} merged"
    assert sha in redact_string(text)


# ---------------------------------------------------------------------------
# Recursive value walk: token redaction must reach into nested structures.
# ---------------------------------------------------------------------------


def test_redact_value_dict_recursive() -> None:
    event = {
        "msg": "minted token",
        "token": "ghs_AAAAAAAAAAAAAAAAAAAA",
        "details": {"auth": "Bearer ghp_BBBBBBBBBBBBBBBBBBBB"},
    }
    out = _redact_value(event)
    assert out["token"] == "gh*_[REDACTED]"
    assert out["details"]["auth"] == "Bearer [REDACTED]"


def test_redact_value_list_recursive() -> None:
    event = {"tokens": ["ghs_AAAAAAAAAAAAAAAAAAAA", "ghs_BBBBBBBBBBBBBBBBBBBB"]}
    out = _redact_value(event)
    assert all(t == "gh*_[REDACTED]" for t in out["tokens"])


def test_redact_value_tuple_preserves_type() -> None:
    out = _redact_value(("ghp_AAAAAAAAAAAAAAAAAAAA", "plain"))
    assert isinstance(out, tuple)
    assert out[0] == "gh*_[REDACTED]"
    assert out[1] == "plain"


def test_redact_value_passes_non_strings() -> None:
    event = {"count": 42, "ok": True, "missing": None, "ratio": 3.14}
    assert _redact_value(event) == event


def test_redact_value_handles_deeply_nested() -> None:
    event = {"a": {"b": {"c": {"d": "ghs_AAAAAAAAAAAAAAAAAAAA"}}}}
    out = _redact_value(event)
    assert out["a"]["b"]["c"]["d"] == "gh*_[REDACTED]"


# ---------------------------------------------------------------------------
# structlog processor integration: the on-wire JSON must be redacted.
# ---------------------------------------------------------------------------


def test_processor_returns_event_dict() -> None:
    event = {"event": "minted", "token": "ghs_AAAAAAAAAAAAAAAAAAAA"}
    out = redact_processor(None, "info", event)
    assert out["token"] == "gh*_[REDACTED]"
    assert out["event"] == "minted"


def test_configure_logging_emits_redacted_json() -> None:
    # Capture stderr-bound output by re-pointing structlog's WriteLogger
    # at an in-memory buffer. configure_logging() defaults to sys.stderr,
    # so we re-bind after configure().
    buffer = io.StringIO()
    configure_logging(level="debug")
    structlog.configure(
        processors=structlog.get_config()["processors"],
        wrapper_class=structlog.get_config()["wrapper_class"],
        logger_factory=structlog.WriteLoggerFactory(file=buffer),
        cache_logger_on_first_use=False,
    )
    log = structlog.get_logger()
    log.info("minted token", service="foxstoria", token="ghs_AAAAAAAAAAAAAAAAAAAA")

    output = buffer.getvalue()
    assert output, "expected at least one log line"
    record = json.loads(output.strip().splitlines()[-1])
    assert record["event"] == "minted token"
    assert record["service"] == "foxstoria"
    assert record["token"] == "gh*_[REDACTED]"
    assert "ghs_AAAA" not in output


def test_configure_logging_respects_level() -> None:
    buffer = io.StringIO()
    configure_logging(level="error")
    structlog.configure(
        processors=structlog.get_config()["processors"],
        wrapper_class=structlog.get_config()["wrapper_class"],
        logger_factory=structlog.WriteLoggerFactory(file=buffer),
        cache_logger_on_first_use=False,
    )
    log = structlog.get_logger()
    log.info("info-level should be filtered out")
    log.error("error-level should appear")

    output = buffer.getvalue()
    assert "filtered out" not in output
    assert "should appear" in output
