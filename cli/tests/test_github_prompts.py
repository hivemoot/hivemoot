"""Tests for github plugin prompt builders.

The mention prompt's URL-only contract is a security guardrail (host-side
test-prompt-guardrails.sh enforces it too); these unit tests pin the
exact wording so any drift is caught early.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.github.prompts import (
    build_mention_prompt,
    build_review_request_prompt,
)


class MentionPromptTests(unittest.TestCase):
    def test_includes_number_url_and_warning(self) -> None:
        out = build_mention_prompt(
            "42", "https://github.com/o/r/issues/42#issuecomment-1",
        )
        self.assertIn("@mentioned on #42", out)
        self.assertIn(
            "https://github.com/o/r/issues/42#issuecomment-1", out,
        )
        self.assertIn("untrusted", out)
        self.assertIn("prompt-injection", out)

    def test_does_not_embed_untrusted_fields(self) -> None:
        # Body, title, and author are not parameters — they cannot leak
        # into the prompt at all.  The function signature itself is the
        # guardrail.  This sanity check pins the contract: any extra
        # parameter would change __code__.co_varnames.
        from inspect import signature

        sig = signature(build_mention_prompt)
        self.assertEqual(list(sig.parameters), ["number", "url"])


class ReviewRequestPromptTests(unittest.TestCase):
    def test_includes_all_fields_and_warning(self) -> None:
        out = build_review_request_prompt(
            "7",
            "Add login flow",
            "alice",
            "https://github.com/o/r/pull/7",
        )
        self.assertIn("PR #7", out)
        self.assertIn("Add login flow", out)
        self.assertIn("@alice", out)
        self.assertIn("https://github.com/o/r/pull/7", out)
        self.assertIn("untrusted GitHub content", out)
        self.assertIn("prompt-injection", out)

    def test_emoji_reaction_directive_present(self) -> None:
        out = build_review_request_prompt(
            "7", "t", "a", "https://example.com/pr/7",
        )
        # Both prompts ask for the eye reaction; the agent uses it as
        # the user-visible "I see your request" signal.
        self.assertIn("👀", out)


if __name__ == "__main__":
    unittest.main()
