"""Tests for GitHub watch triggers + plugin ack lifecycle.

Covers:
  * triggers() env-gating (off / mention only / both)
  * trigger.validate() error surface
  * trigger.start() dispatches one job per parsed event with the right
    session key, prompt body, and ack metadata
  * trigger.stop() unblocks start() promptly
  * plugin.on_job_finished() acks on success and skips ack on failure
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import AgentResult, Job, PluginConfig
from hivemoot_agent.plugins_builtin.github import (
    GitHubMentionsTrigger,
    GitHubReviewRequestsTrigger,
    create_plugin,
)
from hivemoot_agent.plugins_builtin.github import watcher


class _EnvIsolated(unittest.TestCase):
    """Each test gets a fresh os.environ snapshot."""

    def setUp(self) -> None:
        self._saved = dict(os.environ)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._saved)


# ── triggers() env-gating ──────────────────────────────────────────


class TriggersGatingTests(_EnvIsolated):
    def test_disabled_by_default(self) -> None:
        for k in (
            "GITHUB_WATCH_MENTIONS", "GITHUB_WATCH_REVIEW_REQUESTS",
        ):
            os.environ.pop(k, None)
        self.assertEqual(create_plugin().triggers(), [])

    def test_only_mentions_when_only_mentions_enabled(self) -> None:
        os.environ["GITHUB_WATCH_MENTIONS"] = "1"
        os.environ.pop("GITHUB_WATCH_REVIEW_REQUESTS", None)
        triggers = create_plugin().triggers()
        self.assertEqual(len(triggers), 1)
        self.assertIsInstance(triggers[0], GitHubMentionsTrigger)

    def test_both_when_both_enabled(self) -> None:
        os.environ["GITHUB_WATCH_MENTIONS"] = "1"
        os.environ["GITHUB_WATCH_REVIEW_REQUESTS"] = "1"
        triggers = create_plugin().triggers()
        self.assertEqual(
            sorted(t.name for t in triggers),
            ["github-mention", "github-review-request"],
        )

    def test_truthy_values_accepted(self) -> None:
        for value in ("true", "TRUE", "yes", "on"):
            os.environ["GITHUB_WATCH_MENTIONS"] = value
            os.environ.pop("GITHUB_WATCH_REVIEW_REQUESTS", None)
            self.assertEqual(
                len(create_plugin().triggers()), 1,
                f"value={value!r} should enable mentions",
            )

    def test_falsy_values_disabled(self) -> None:
        for value in ("0", "", "no", "false"):
            os.environ["GITHUB_WATCH_MENTIONS"] = value
            os.environ.pop("GITHUB_WATCH_REVIEW_REQUESTS", None)
            self.assertEqual(
                create_plugin().triggers(), [],
                f"value={value!r} should keep mentions disabled",
            )


# ── validate() ─────────────────────────────────────────────────────


class TriggerValidationTests(unittest.TestCase):
    def test_missing_repo_rejected(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        cfg = PluginConfig(name="github", settings={"GITHUB_TOKEN": "t"})
        errors = trig.validate(cfg)
        self.assertTrue(
            any("TARGET_REPO or GITHUB_REPOS" in e for e in errors)
        )

    def test_missing_token_rejected(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        cfg = PluginConfig(name="github", settings={
            "GITHUB_REPOS": "o/r",
        })
        errors = trig.validate(cfg)
        self.assertTrue(
            any("GITHUB_TOKEN" in e for e in errors),
        )

    def test_complete_config_passes(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        cfg = PluginConfig(name="github", settings={
            "GITHUB_REPOS": "o/r",
            "GITHUB_TOKEN": "t",
        })
        self.assertEqual(trig.validate(cfg), [])


# ── start() dispatch loop ──────────────────────────────────────────


class TriggerDispatchTests(unittest.TestCase):
    def _config(self, **overrides) -> PluginConfig:
        tmp = tempfile.mkdtemp()
        settings = {
            "GITHUB_REPOS": "owner/repo",
            "GITHUB_TOKEN": "tok",
            "GITHUB_WATCH_POLL_INTERVAL": "0",
            "GITHUB_WATCH_STATE_DIR": tmp,
            "AGENT_MEMORY_DIR": tmp,
        }
        settings.update(overrides)
        return PluginConfig(name="github", settings=settings)

    def test_mention_dispatch_one_event(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        events = [
            watcher.WatchEvent(
                thread_id="t1", number="42", title="hi",
                author="alice", url="https://x/1",
                timestamp="2026-04-17T00:00:00Z",
            ),
        ]
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        with patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=events,
        ):
            # Single iteration: stop after first dispatch.
            def stop_after_dispatch(_job):
                trig.stop()
                return True
            dispatcher.dispatch.side_effect = stop_after_dispatch
            trig.start(self._config(), dispatcher)

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args.args[0]
        self.assertEqual(job.session_key, "mention-thread:t1")
        self.assertIn("@mentioned on #42", job.prompt)
        meta = job.metadata["github_watch"]
        self.assertEqual(meta["trigger"], "github-mention")
        self.assertEqual(meta["ack_key"], "t1:2026-04-17T00:00:00Z")
        self.assertTrue(meta["state_file"].endswith("mentions.json"))

    def test_review_request_dispatch_one_event(self) -> None:
        trig = GitHubReviewRequestsTrigger(MagicMock())
        events = [
            watcher.WatchEvent(
                thread_id="t9", number="7", title="Add login",
                author="bob", url="https://x/pr/7",
                timestamp="2026-04-17T00:00:00Z",
            ),
        ]
        dispatcher = MagicMock()
        with patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=events,
        ), patch.object(trig, "_stop_event") as stop_event:
            stop_event.is_set.side_effect = [False, False, True]
            stop_event.wait.return_value = None
            trig.start(self._config(), dispatcher)

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args.args[0]
        self.assertEqual(job.session_key, "review-pr:7")
        self.assertIn("PR #7", job.prompt)
        meta = job.metadata["github_watch"]
        self.assertEqual(meta["trigger"], "github-review-request")
        self.assertTrue(meta["state_file"].endswith("review-requests.json"))

    def test_review_trigger_passes_review_reasons(self) -> None:
        trig = GitHubReviewRequestsTrigger(MagicMock())
        with patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=[],
        ) as poll, patch.object(trig, "_stop_event") as stop_event:
            stop_event.is_set.side_effect = [False, True]
            stop_event.wait.return_value = None
            trig.start(self._config(), MagicMock())
        poll.assert_called_once()
        kwargs = poll.call_args.kwargs
        self.assertEqual(kwargs["reasons"], ["review_requested"])

    def test_mention_trigger_passes_no_reasons(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        with patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=[],
        ) as poll, patch.object(trig, "_stop_event") as stop_event:
            stop_event.is_set.side_effect = [False, True]
            stop_event.wait.return_value = None
            trig.start(self._config(), MagicMock())
        poll.assert_called_once()
        self.assertIsNone(poll.call_args.kwargs["reasons"])

    def test_poll_failure_does_not_abort_loop(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        call_count = {"n": 0}

        def fake_poll(**kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("transient")
            trig.stop()
            return []

        with patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            side_effect=fake_poll,
        ), patch("sys.stderr", io.StringIO()):
            trig.start(self._config(), MagicMock())

        self.assertEqual(call_count["n"], 2)

    def test_missing_repo_in_start_returns_silently(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        cfg = PluginConfig(name="github", settings={"GITHUB_TOKEN": "t"})
        with patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once"
        ) as poll, patch("sys.stderr", io.StringIO()):
            trig.start(cfg, MagicMock())
        poll.assert_not_called()

    def test_stop_unblocks_start_promptly(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        with patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=[],
        ):
            done = threading.Event()

            def runner():
                trig.start(self._config(GITHUB_WATCH_POLL_INTERVAL="60"),
                           MagicMock())
                done.set()

            t = threading.Thread(target=runner, daemon=True)
            t.start()
            time.sleep(0.05)
            trig.stop()
            self.assertTrue(done.wait(timeout=2.0),
                            "trigger.start did not exit after stop")


# ── plugin.on_job_finished ack lifecycle ───────────────────────────


class PluginAckLifecycleTests(_EnvIsolated):
    def _config(self) -> PluginConfig:
        return PluginConfig(name="github", settings={
            "GITHUB_TOKEN": "tok",
            "GITHUB_REPOS": "o/r",
        })

    def _job_with_meta(self, **meta) -> Job:
        return Job(
            session_key="mention-thread:t1",
            prompt="hi",
            metadata={"github_watch": {
                "trigger": "github-mention",
                "ack_key": "t1:ts",
                "state_file": "/state/mentions.json",
                "number": "42",
                **meta,
            }},
        )

    def test_success_calls_ack(self) -> None:
        plugin = create_plugin()
        job = self._job_with_meta()
        result = AgentResult(exit_code=0, response="ok")
        with patch(
            "hivemoot_agent.plugins_builtin.github.ack_module.ack_event",
            return_value=True,
        ) as ack:
            plugin.on_job_finished(job, result, self._config())
        ack.assert_called_once_with("t1:ts", "/state/mentions.json", "tok")

    def test_failure_skips_ack(self) -> None:
        plugin = create_plugin()
        job = self._job_with_meta()
        result = AgentResult(exit_code=1, response="boom")
        with patch(
            "hivemoot_agent.plugins_builtin.github.ack_module.ack_event"
        ) as ack, patch("sys.stderr", io.StringIO()):
            plugin.on_job_finished(job, result, self._config())
        ack.assert_not_called()

    def test_no_metadata_is_noop(self) -> None:
        plugin = create_plugin()
        job = Job(session_key="x", prompt="x")
        result = AgentResult(exit_code=0, response="ok")
        with patch(
            "hivemoot_agent.plugins_builtin.github.ack_module.ack_event"
        ) as ack:
            plugin.on_job_finished(job, result, self._config())
        ack.assert_not_called()


if __name__ == "__main__":
    unittest.main()
