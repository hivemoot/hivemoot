"""Tests for hivemoot.sanitize.redact_secrets.

The ``error`` field posted to /api/agent-health (and the tasks
post_fail ``error`` field) is a diagnostic channel and must not
leak secrets from the agent's failure output.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.sanitize import redact_secrets


class RedactSecretsTests(unittest.TestCase):
    def test_empty_input_passes_through(self) -> None:
        self.assertEqual(redact_secrets(""), "")

    def test_plain_text_untouched(self) -> None:
        text = "Task failed: expected commit message, got nothing"
        self.assertEqual(redact_secrets(text), text)

    def test_bearer_header_redacted(self) -> None:
        text = "curl failed: Authorization: Bearer sk_ant_verylong_secret_1234 expired"
        out = redact_secrets(text)
        self.assertNotIn("sk_ant_verylong_secret", out)
        self.assertIn("Bearer [REDACTED]", out)

    def test_openai_style_key_redacted(self) -> None:
        text = "got 401 from sk-abcdef1234567890FEDCBA9876543210 — check creds"
        out = redact_secrets(text)
        self.assertNotIn("abcdef1234567890FEDCBA", out)
        self.assertIn("sk-[REDACTED]", out)

    def test_anthropic_style_key_redacted(self) -> None:
        text = "api error: sk-ant-abcdef1234567890FEDCBA9876543210 rejected"
        out = redact_secrets(text)
        self.assertNotIn("sk-ant-abcdef1234567890", out)

    def test_github_token_redacted(self) -> None:
        for prefix in ("ghp_", "ghs_", "gho_", "ghu_"):
            token = f"{prefix}ABCDEFGHIJKLMNOPQRSTUVWX"
            text = f"git push failed: bad credentials {token}"
            out = redact_secrets(text)
            self.assertNotIn(token, out, f"failed to scrub {prefix}")

    def test_query_style_token_redacted(self) -> None:
        text = "POST failed: url=https://api.example/x?token=abcdef1234567890 rejected"
        out = redact_secrets(text)
        self.assertNotIn("token=abcdef1234567890", out)
        self.assertIn("[REDACTED]", out)

    def test_api_key_field_redacted(self) -> None:
        text = 'config error: api_key: "sk_abcd1234567890ABCD" is malformed'
        out = redact_secrets(text)
        self.assertNotIn("sk_abcd1234567890ABCD", out)

    def test_multiple_secrets_all_redacted(self) -> None:
        text = (
            "Auth cascade: Bearer abcdef1234 failed, falling back to "
            "sk-xyz9876543210FEDCBA9876543210 which also failed"
        )
        out = redact_secrets(text)
        self.assertNotIn("abcdef1234", out)
        self.assertNotIn("sk-xyz", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
