"""Tests for GitHub watch triggers + plugin ack lifecycle.

Covers:
  * triggers() gating by typed ``GitHubConfig.watch_*`` flags
  * trigger.validate() error surface for the typed-config contract
  * trigger.start() dispatches one Job per parsed event with the right
    session key, prompt body, and ack metadata (including ack_strategy)
  * trigger.stop() unblocks start() promptly
  * plugin.on_job_finished() acks on success (via the right strategy)
    and skips ack on failure
"""

from __future__ import annotations

import io
import json
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
    GitHubNewPullRequestsTrigger,
    GitHubReviewRequestsTrigger,
    create_plugin,
    pr_watcher,
    watcher,
)
from hivemoot_agent.plugins_builtin.github.config import GitHubConfig


def _make_cfg(
    *,
    repos=("owner/repo",),
    token_file: str = "",
    watch_mentions: bool = False,
    watch_review_requests: bool = False,
    watch_new_prs: bool = False,
    watch_new_prs_authors=(),
    watch_poll_interval_secs: int = 30,
    watch_state_dir: str = "",
    agent_memory_dir: str = "",
) -> GitHubConfig:
    return GitHubConfig(
        repos=list(repos),
        token_file=(token_file or None),
        watch_mentions=watch_mentions,
        watch_review_requests=watch_review_requests,
        watch_new_prs=watch_new_prs,
        watch_new_prs_authors=list(watch_new_prs_authors),
        watch_poll_interval_secs=watch_poll_interval_secs,
        watch_state_dir=(watch_state_dir or None),
        agent_memory_dir=(agent_memory_dir or None),
    )


def _plugin_config(cfg: GitHubConfig) -> PluginConfig:
    # PluginConfig.typed is the typed-config slot used by the plugin.
    pc = PluginConfig(name="github", settings={})
    pc.typed = cfg
    return pc


def _write_token(tmpdir: str, value: str = "tok") -> str:
    path = os.path.join(tmpdir, "token")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(value)
    return path


# ── triggers() gating ──────────────────────────────────────────────


class TriggersGatingTests(unittest.TestCase):
    def test_disabled_by_default(self) -> None:
        plugin = create_plugin()
        plugin._cfg = _make_cfg()  # all watch_* default False
        self.assertEqual(plugin.triggers(), [])

    def test_only_mentions_when_only_mentions_enabled(self) -> None:
        plugin = create_plugin()
        plugin._cfg = _make_cfg(watch_mentions=True)
        triggers = plugin.triggers()
        self.assertEqual(len(triggers), 1)
        self.assertIsInstance(triggers[0], GitHubMentionsTrigger)

    def test_all_three_when_all_enabled(self) -> None:
        plugin = create_plugin()
        plugin._cfg = _make_cfg(
            watch_mentions=True,
            watch_review_requests=True,
            watch_new_prs=True,
        )
        triggers = plugin.triggers()
        self.assertEqual(
            sorted(t.name for t in triggers),
            ["github-mention", "github-new-pr", "github-review-request"],
        )

    def test_only_new_prs_when_only_new_prs_enabled(self) -> None:
        plugin = create_plugin()
        plugin._cfg = _make_cfg(watch_new_prs=True)
        triggers = plugin.triggers()
        self.assertEqual(len(triggers), 1)
        self.assertIsInstance(triggers[0], GitHubNewPullRequestsTrigger)

    def test_no_cfg_returns_empty(self) -> None:
        plugin = create_plugin()
        plugin._cfg = None
        self.assertEqual(plugin.triggers(), [])


# ── validate() ─────────────────────────────────────────────────────


class TriggerValidationTests(unittest.TestCase):
    def test_missing_typed_config_rejected(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        errors = trig.validate(PluginConfig(name="github", settings={}))
        self.assertTrue(
            any("typed github config" in e for e in errors),
            f"expected typed-config error, got {errors}",
        )

    def test_missing_repo_rejected(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir:
            cfg = _make_cfg(repos=(), token_file=_write_token(tmpdir))
            errors = trig.validate(_plugin_config(cfg))
        self.assertTrue(any("target_repo" in e or "repos" in e for e in errors))

    def test_missing_token_rejected(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        cfg = _make_cfg()  # token_file unset
        errors = trig.validate(_plugin_config(cfg))
        self.assertTrue(any("token_file" in e for e in errors))

    def test_complete_config_passes(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir:
            cfg = _make_cfg(token_file=_write_token(tmpdir))
            self.assertEqual(trig.validate(_plugin_config(cfg)), [])


# ── start() dispatch loop ──────────────────────────────────────────


class TriggerDispatchTests(unittest.TestCase):
    def _config(self, tmpdir: str, **cfg_overrides) -> PluginConfig:
        cfg_kwargs = {
            "token_file": _write_token(tmpdir),
            "watch_poll_interval_secs": 30,
            "watch_state_dir": tmpdir,
            "agent_memory_dir": tmpdir,
        }
        cfg_kwargs.update(cfg_overrides)
        return _plugin_config(_make_cfg(**cfg_kwargs))

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

        def stop_after_dispatch(_job):
            trig.stop()
            return True

        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=events,
        ):
            dispatcher.dispatch.side_effect = stop_after_dispatch
            trig.start(self._config(tmpdir), dispatcher)

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args.args[0]
        self.assertEqual(job.session_key, "mention-thread:t1")
        self.assertIn("@mentioned on #42", job.prompt)
        meta = job.metadata["github_watch"]
        self.assertEqual(meta["trigger"], "github-mention")
        self.assertEqual(meta["ack_strategy"], "notification")
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
        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=events,
        ), patch.object(trig, "_stop_event") as stop_event:
            stop_event.is_set.side_effect = [False, False, True]
            stop_event.wait.return_value = None
            trig.start(self._config(tmpdir), dispatcher)

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args.args[0]
        self.assertEqual(job.session_key, "review-pr:7")
        self.assertIn("PR #7", job.prompt)
        meta = job.metadata["github_watch"]
        self.assertEqual(meta["trigger"], "github-review-request")
        self.assertEqual(meta["ack_strategy"], "notification")
        self.assertTrue(meta["state_file"].endswith("review-requests.json"))

    def test_review_trigger_passes_review_reasons(self) -> None:
        trig = GitHubReviewRequestsTrigger(MagicMock())
        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=[],
        ) as poll, patch.object(trig, "_stop_event") as stop_event:
            stop_event.is_set.side_effect = [False, True]
            stop_event.wait.return_value = None
            trig.start(self._config(tmpdir), MagicMock())
        poll.assert_called_once()
        self.assertEqual(poll.call_args.kwargs["reasons"], ["review_requested"])

    def test_mention_trigger_passes_no_reasons(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=[],
        ) as poll, patch.object(trig, "_stop_event") as stop_event:
            stop_event.is_set.side_effect = [False, True]
            stop_event.wait.return_value = None
            trig.start(self._config(tmpdir), MagicMock())
        poll.assert_called_once()
        self.assertIsNone(poll.call_args.kwargs["reasons"])

    def test_new_pr_dispatch_one_event(self) -> None:
        trig = GitHubNewPullRequestsTrigger(MagicMock())
        events = [
            pr_watcher.PullRequestEvent(
                number="99",
                title="Automate release",
                author="hivemoot",
                url="https://x/pr/99",
                created_at="2026-04-19T12:00:00Z",
            ),
        ]
        dispatcher = MagicMock()
        dispatcher.dispatch.return_value = True

        def stop_after_dispatch(_job):
            trig.stop()
            return True

        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.trigger.pr_watcher.poll_new_prs_once",
            return_value=events,
        ):
            dispatcher.dispatch.side_effect = stop_after_dispatch
            trig.start(
                self._config(tmpdir, watch_new_prs=True,
                             watch_new_prs_authors=("hivemoot",)),
                dispatcher,
            )

        dispatcher.dispatch.assert_called_once()
        job = dispatcher.dispatch.call_args.args[0]
        self.assertEqual(job.session_key, "new-pr:99")
        self.assertIn("PR #99", job.prompt)
        meta = job.metadata["github_watch"]
        self.assertEqual(meta["trigger"], "github-new-pr")
        self.assertEqual(meta["ack_strategy"], "new_pr")
        self.assertEqual(meta["ack_key"], "99")
        self.assertTrue(meta["state_file"].endswith("new-prs.json"))

    def test_new_pr_trigger_passes_author_filter(self) -> None:
        trig = GitHubNewPullRequestsTrigger(MagicMock())
        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.trigger.pr_watcher.poll_new_prs_once",
            return_value=[],
        ) as poll, patch.object(trig, "_stop_event") as stop_event:
            stop_event.is_set.side_effect = [False, True]
            stop_event.wait.return_value = None
            trig.start(
                self._config(tmpdir, watch_new_prs=True,
                             watch_new_prs_authors=("alice", "BOB")),
                MagicMock(),
            )
        poll.assert_called_once()
        self.assertEqual(poll.call_args.kwargs["authors"], ["alice", "BOB"])

    def test_poll_failure_does_not_abort_loop(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        call_count = {"n": 0}

        def fake_poll(**kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("transient")
            trig.stop()
            return []

        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            side_effect=fake_poll,
        ), patch.object(trig, "_stop_event") as stop_event, patch(
            "sys.stderr", io.StringIO(),
        ):
            # is_set() pattern: enter loop → catch exception → enter loop
            # → call fake_poll (stops inside) → exit.
            stop_event.is_set.side_effect = [False, False, True]
            stop_event.wait.return_value = None
            # stop_event.set() is what trig.stop() calls; keep MagicMock
            # behavior by letting it be a no-op beyond recording.
            stop_event.set.return_value = None
            trig.start(self._config(tmpdir), MagicMock())

        self.assertEqual(call_count["n"], 2)

    def test_missing_typed_cfg_in_start_returns_silently(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        pc = PluginConfig(name="github", settings={})  # no cfg
        with patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once"
        ) as poll, patch("sys.stderr", io.StringIO()):
            trig.start(pc, MagicMock())
        poll.assert_not_called()

    def test_stop_unblocks_start_promptly(self) -> None:
        trig = GitHubMentionsTrigger(MagicMock())
        with tempfile.TemporaryDirectory(prefix="hm-gh-trig-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.trigger.watcher.poll_once",
            return_value=[],
        ):
            done = threading.Event()

            def runner():
                trig.start(
                    self._config(tmpdir, watch_poll_interval_secs=60),
                    MagicMock(),
                )
                done.set()

            t = threading.Thread(target=runner, daemon=True)
            t.start()
            time.sleep(0.05)
            trig.stop()
            self.assertTrue(done.wait(timeout=2.0),
                            "trigger.start did not exit after stop")


# ── plugin.on_job_finished ack lifecycle ───────────────────────────


class PluginAckLifecycleTests(unittest.TestCase):
    def _plugin_config(self, tmpdir: str) -> PluginConfig:
        cfg = _make_cfg(token_file=_write_token(tmpdir))
        return _plugin_config(cfg)

    def _mention_job(self, **meta) -> Job:
        return Job(
            session_key="mention-thread:t1",
            prompt="hi",
            metadata={"github_watch": {
                "trigger": "github-mention",
                "ack_strategy": "notification",
                "ack_key": "t1:ts",
                "state_file": "/state/mentions.json",
                "number": "42",
                **meta,
            }},
        )

    def _new_pr_job(self, **meta) -> Job:
        return Job(
            session_key="new-pr:99",
            prompt="hi",
            metadata={"github_watch": {
                "trigger": "github-new-pr",
                "ack_strategy": "new_pr",
                "ack_key": "99",
                "state_file": "/state/new-prs.json",
                "number": "99",
                **meta,
            }},
        )

    def test_notification_success_calls_ack_event(self) -> None:
        plugin = create_plugin()
        job = self._mention_job()
        result = AgentResult(exit_code=0, response="ok")
        with tempfile.TemporaryDirectory(prefix="hm-gh-ack-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.ack_module.ack_event",
            return_value=True,
        ) as ack:
            plugin.on_job_finished(
                job, result, self._plugin_config(tmpdir),
            )
        ack.assert_called_once()
        args = ack.call_args.args
        self.assertEqual(args[0], "t1:ts")
        self.assertEqual(args[1], "/state/mentions.json")
        self.assertEqual(args[2], "tok")

    def test_new_pr_success_calls_ack_new_pr(self) -> None:
        plugin = create_plugin()
        job = self._new_pr_job()
        result = AgentResult(exit_code=0, response="ok")
        with tempfile.TemporaryDirectory(prefix="hm-gh-ack-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.pr_watcher.ack_new_pr",
            return_value=True,
        ) as ack:
            plugin.on_job_finished(
                job, result, self._plugin_config(tmpdir),
            )
        ack.assert_called_once_with("99", "/state/new-prs.json")

    def test_legacy_metadata_without_ack_strategy_uses_notification(self) -> None:
        """Old dispatchers never set ack_strategy; default to notification."""
        plugin = create_plugin()
        job = Job(
            session_key="mention-thread:t1",
            prompt="hi",
            metadata={"github_watch": {
                "trigger": "github-mention",
                "ack_key": "t1:ts",
                "state_file": "/state/mentions.json",
                "number": "42",
            }},
        )
        result = AgentResult(exit_code=0, response="ok")
        with tempfile.TemporaryDirectory(prefix="hm-gh-ack-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.ack_module.ack_event",
            return_value=True,
        ) as ack_event, patch(
            "hivemoot_agent.plugins_builtin.github.pr_watcher.ack_new_pr"
        ) as ack_new_pr:
            plugin.on_job_finished(
                job, result, self._plugin_config(tmpdir),
            )
        ack_event.assert_called_once()
        ack_new_pr.assert_not_called()

    def test_failure_skips_ack(self) -> None:
        plugin = create_plugin()
        job = self._mention_job()
        result = AgentResult(exit_code=1, response="boom")
        with tempfile.TemporaryDirectory(prefix="hm-gh-ack-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.ack_module.ack_event"
        ) as ack, patch("sys.stderr", io.StringIO()):
            plugin.on_job_finished(
                job, result, self._plugin_config(tmpdir),
            )
        ack.assert_not_called()

    def test_new_pr_failure_skips_ack(self) -> None:
        plugin = create_plugin()
        job = self._new_pr_job()
        result = AgentResult(exit_code=1, response="boom")
        with tempfile.TemporaryDirectory(prefix="hm-gh-ack-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.pr_watcher.ack_new_pr"
        ) as ack, patch("sys.stderr", io.StringIO()):
            plugin.on_job_finished(
                job, result, self._plugin_config(tmpdir),
            )
        ack.assert_not_called()

    def test_unknown_ack_strategy_logged_not_crashed(self) -> None:
        plugin = create_plugin()
        job = self._mention_job(ack_strategy="made-up")
        result = AgentResult(exit_code=0, response="ok")
        buf = io.StringIO()
        with tempfile.TemporaryDirectory(prefix="hm-gh-ack-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.ack_module.ack_event"
        ) as ack, patch("sys.stderr", buf):
            plugin.on_job_finished(
                job, result, self._plugin_config(tmpdir),
            )
        ack.assert_not_called()
        self.assertIn("unknown ack strategy", buf.getvalue())

    def test_no_metadata_is_noop(self) -> None:
        plugin = create_plugin()
        job = Job(session_key="x", prompt="x")
        result = AgentResult(exit_code=0, response="ok")
        with tempfile.TemporaryDirectory(prefix="hm-gh-ack-") as tmpdir, patch(
            "hivemoot_agent.plugins_builtin.github.ack_module.ack_event"
        ) as ack:
            plugin.on_job_finished(
                job, result, self._plugin_config(tmpdir),
            )
        ack.assert_not_called()


if __name__ == "__main__":
    unittest.main()
