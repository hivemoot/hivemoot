"""Tests for ``hivemoot_agent.providers.opencode``.

Pins the security-affecting argv composition: opencode is invoked with
``--dangerously-skip-permissions`` so headless container runs don't get
silently blocked by opencode's interactive permission "ask" prompts.

Without this flag, drone (and any other opencode-backed agent) reaches
``gh pr review`` and exits cleanly without posting because opencode
treats the bash tool call as needing external_directory access, which
defaults to "ask" → blocks in non-interactive mode. The flag is the
documented opencode escape hatch; explicit deny patterns in the
operator's opencode.json (``*.env`` / ``*.key`` / ``*.pem`` /
``*secret*`` on read; ``doom_loop`` deny) remain in force.

Test coverage:

- ``--dangerously-skip-permissions`` is in argv (positional check —
  must appear before the prompt body).
- ``--model`` flag carried through when supplied.
- ``OPENCODE_MODEL`` env override beats the ``model`` parameter
  (existing behavior; pin against regression).
- Prompt body is appended last so it's not interpreted as a flag.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.providers import opencode


class OpenCodeBuildCmdTest(unittest.TestCase):
    """Argv composition guarantees for the opencode provider."""

    def setUp(self) -> None:
        # OPENCODE_MODEL bleeds across tests; isolate.
        self._orig_opencode_model = os.environ.pop("OPENCODE_MODEL", None)

    def tearDown(self) -> None:
        if self._orig_opencode_model is None:
            os.environ.pop("OPENCODE_MODEL", None)
        else:
            os.environ["OPENCODE_MODEL"] = self._orig_opencode_model

    def _build(self, **overrides) -> list[str]:
        defaults = {
            "prompt": "Review the PR.",
            "system_prompt": "You are drone.",
            "model": "zai/glm-5.1",
            "mcp_config": "",
            "session_id": "",
        }
        defaults.update(overrides)
        return opencode.build_cmd(**defaults)

    def test_dangerously_skip_permissions_in_argv(self) -> None:
        """Security-affecting flag MUST be present so opencode auto-
        approves in headless container mode (otherwise external_directory
        rules silently block bash → no review ever posted)."""
        argv = self._build()
        self.assertIn(
            "--dangerously-skip-permissions",
            argv,
            "opencode provider must invoke with --dangerously-skip-permissions; "
            "without it, headless containers get silently blocked at gh/git "
            "subprocess invocations",
        )

    def test_dangerously_skip_permissions_appears_before_prompt(self) -> None:
        """Flag must precede the positional prompt argument so opencode's
        argv parser treats it as a flag rather than message content."""
        argv = self._build(prompt="REVIEW_PROMPT_BODY")
        flag_idx = argv.index("--dangerously-skip-permissions")
        # The combined "system_prompt\n\nprompt" string is the last positional
        prompt_idx = next(
            i for i, a in enumerate(argv) if "REVIEW_PROMPT_BODY" in a
        )
        self.assertLess(
            flag_idx, prompt_idx,
            "the security flag must come before the prompt positional",
        )

    def test_argv_starts_with_opencode_run(self) -> None:
        argv = self._build()
        self.assertEqual(argv[0], "opencode")
        self.assertEqual(argv[1], "run")

    def test_model_flag_carries_when_supplied(self) -> None:
        argv = self._build(model="zai/glm-5.1")
        self.assertIn("--model", argv)
        idx = argv.index("--model")
        self.assertEqual(argv[idx + 1], "zai/glm-5.1")

    def test_no_model_flag_when_neither_param_nor_env_set(self) -> None:
        argv = self._build(model="")
        self.assertNotIn("--model", argv)

    def test_opencode_model_env_overrides_model_parameter(self) -> None:
        """Existing precedence: OPENCODE_MODEL env var beats the
        generic AGENT_MODEL passed as the model parameter. Pin so a
        future build_cmd refactor can't silently invert this."""
        os.environ["OPENCODE_MODEL"] = "zai/glm-5.1"
        argv = self._build(model="claude/opus-4-7")
        idx = argv.index("--model")
        self.assertEqual(
            argv[idx + 1], "zai/glm-5.1",
            "OPENCODE_MODEL env var should win over the model parameter",
        )

    def test_combined_prompt_is_last_positional(self) -> None:
        """The combined system+user prompt is appended last so it can't
        be re-interpreted as a flag value."""
        argv = self._build(
            prompt="USER_BODY",
            system_prompt="SYSTEM_BODY",
        )
        last = argv[-1]
        self.assertIn("SYSTEM_BODY", last)
        self.assertIn("USER_BODY", last)


if __name__ == "__main__":
    unittest.main()
