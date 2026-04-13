"""Tests for streaming progress: provider parsing, status formatting, plugin behavior."""

import io
import json
import os
import sys
import threading
import time
import urllib.error
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import AgentEvent, Job, AgentResult, PluginConfig


# ── Provider parse_event tests ───────────────────────────────────


def test_claude_parse_event_assistant_message():
    from hivemoot_agent.providers.claude import parse_event

    line = '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me help you"}]}}'
    event = parse_event(line)
    assert event is not None
    assert event.kind == "assistant_message"
    assert event.text == "Let me help you"


def test_claude_parse_event_tool_use_with_text_keeps_status_text():
    from hivemoot_agent.providers.claude import parse_event

    line = '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading file"},{"type":"tool_use","name":"Read"}]}}'
    event = parse_event(line)
    assert event is not None
    assert event.kind == "assistant_message"
    assert event.tool_name == "Read"
    assert event.text == "Reading file"


def test_claude_parse_event_result():
    from hivemoot_agent.providers.claude import parse_event

    line = '{"type":"result","result":"Here is the answer"}'
    event = parse_event(line)
    assert event is not None
    assert event.kind == "result"
    assert event.text == "Here is the answer"


def test_claude_parse_event_system():
    from hivemoot_agent.providers.claude import parse_event

    line = '{"type":"system","subtype":"init","session_id":"abc-123"}'
    event = parse_event(line)
    assert event is not None
    assert event.kind == "system"


def test_claude_parse_event_non_json():
    from hivemoot_agent.providers.claude import parse_event

    assert parse_event("not json at all") is None
    assert parse_event("") is None
    assert parse_event("   ") is None


def test_claude_parse_event_unknown_type():
    from hivemoot_agent.providers.claude import parse_event

    assert parse_event('{"type":"unknown_event"}') is None


def test_codex_parse_event_thread_started():
    from hivemoot_agent.providers.codex import parse_event

    line = '{"type":"thread.started","thread_id":"tid-123"}'
    event = parse_event(line)
    assert event is not None
    assert event.kind == "system"


def test_codex_parse_event_item_completed():
    from hivemoot_agent.providers.codex import parse_event

    line = '{"type":"item.completed","item":{"type":"agent_message","text":"Done!"}}'
    event = parse_event(line)
    assert event is not None
    assert event.kind == "result"
    assert event.text == "Done!"


def test_codex_parse_event_non_json():
    from hivemoot_agent.providers.codex import parse_event

    assert parse_event("garbage") is None
    assert parse_event("") is None


def test_gemini_parse_event_returns_none():
    from hivemoot_agent.providers.gemini import parse_event

    assert parse_event('{"anything":"here"}') is None
    assert parse_event("text") is None


def test_kilo_parse_event_returns_none():
    from hivemoot_agent.providers.kilo import parse_event

    assert parse_event('{"anything":"here"}') is None


def test_opencode_parse_event_returns_none():
    from hivemoot_agent.providers.opencode import parse_event

    assert parse_event('{"anything":"here"}') is None


# ── Status formatting tests ──────────────────────────────────────


def test_format_status_first_line():
    from hivemoot_agent.plugins_builtin.messaging import _format_status

    assert _format_status("First line\nSecond line\nThird") == "First line"


def test_format_status_truncation():
    from hivemoot_agent.plugins_builtin.messaging import _format_status

    long_text = "A" * 300
    result = _format_status(long_text)
    assert len(result) == 200
    assert result.endswith("...")


def test_format_status_strips_markdown():
    from hivemoot_agent.plugins_builtin.messaging import _format_status

    assert _format_status("## A heading") == "A heading"
    assert _format_status("* A bullet item") == "A bullet item"
    assert _format_status("- A dash item") == "A dash item"
    assert _format_status("### **Bold header**") == "**Bold header**"


def test_format_status_empty():
    from hivemoot_agent.plugins_builtin.messaging import _format_status

    assert _format_status("") == ""
    assert _format_status("   ") == ""


# ── MessagingPlugin.on_agent_output tests ────────────────────────


def _make_plugin():
    """Create a MessagingPlugin with a mock adapter."""
    from hivemoot_agent.plugins_builtin.messaging import MessagingPlugin

    plugin = MessagingPlugin()
    adapter = MagicMock()
    adapter.send_and_get_id = MagicMock(return_value="42")
    adapter.edit_message = MagicMock(return_value=True)
    adapter.delete_message = MagicMock(return_value=True)
    adapter.send = MagicMock(return_value=True)
    adapter.typing = MagicMock(return_value=True)
    plugin._platform_adapter = adapter
    return plugin, adapter


def _drain_status_queue(plugin):
    """Wait for the plugin's async status worker to finish queued work."""
    plugin._status_queue.join()


def test_on_agent_output_creates_status():
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")
    event = AgentEvent(kind="assistant_message", text="Let me look into this for you")

    plugin.on_job_started(job, config)
    plugin.on_agent_output(job, event, config)
    _drain_status_queue(plugin)

    adapter.send_and_get_id.assert_called_once_with(
        config, "12345", "Let me look into this for you",
    )
    assert plugin._status_msg_id == "42"


def test_on_agent_output_edits_status():
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")

    # First event creates the status message.
    event1 = AgentEvent(kind="assistant_message", text="Let me look into this for you")
    plugin.on_job_started(job, config)
    plugin.on_agent_output(job, event1, config)
    _drain_status_queue(plugin)
    assert plugin._status_msg_id == "42"

    # Force past rate limit window.
    plugin._last_status_time = time.monotonic() - 5.0

    # Second event edits the existing message.
    event2 = AgentEvent(kind="assistant_message", text="Here is what I found so far")
    plugin.on_agent_output(job, event2, config)
    _drain_status_queue(plugin)

    adapter.edit_message.assert_called_once_with(
        config, "12345", "42", "Here is what I found so far",
    )


def test_on_agent_output_rate_limits():
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")

    # First event creates the status.
    event1 = AgentEvent(kind="assistant_message", text="Processing your request now")
    plugin.on_job_started(job, config)
    plugin.on_agent_output(job, event1, config)

    # Don't advance the clock — second event should be rate-limited.
    event2 = AgentEvent(kind="assistant_message", text="Still working on your request")
    plugin.on_agent_output(job, event2, config)
    _drain_status_queue(plugin)

    # send_and_get_id called once (creation), edit_message never called.
    adapter.send_and_get_id.assert_called_once()
    adapter.edit_message.assert_not_called()


def test_on_agent_output_ignores_non_assistant():
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")

    for kind in ("system", "tool_use", "result"):
        event = AgentEvent(kind=kind, text="Some text here for testing")
        plugin.on_agent_output(job, event, config)

    adapter.send_and_get_id.assert_not_called()
    adapter.edit_message.assert_not_called()


def test_on_agent_output_ignores_short_text():
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")

    event = AgentEvent(kind="assistant_message", text="OK")
    plugin.on_agent_output(job, event, config)

    adapter.send_and_get_id.assert_not_called()


def test_claude_mixed_text_and_tool_use_reaches_status_update():
    from hivemoot_agent.providers.claude import parse_event

    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")
    line = '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me inspect the repo"},{"type":"tool_use","name":"Read"}]}}'

    event = parse_event(line)
    assert event is not None
    plugin.on_job_started(job, config)
    plugin.on_agent_output(job, event, config)
    _drain_status_queue(plugin)

    adapter.send_and_get_id.assert_called_once_with(
        config, "12345", "Let me inspect the repo",
    )


def test_on_job_finished_deletes_status():
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")

    # Simulate an active status message.
    plugin._status_msg_id = "42"
    plugin._status_chat_id = "12345"

    result = AgentResult(exit_code=0, response="Final answer")
    plugin.on_job_finished(job, result, config)
    _drain_status_queue(plugin)

    adapter.delete_message.assert_called_once_with(config, "12345", "42")
    adapter.send.assert_called_once_with(config, "12345", "Final answer")
    assert plugin._status_msg_id == ""


def test_on_job_finished_no_status_no_delete():
    """If no status was ever shown, don't try to delete anything."""
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")

    result = AgentResult(exit_code=0, response="Quick answer")
    plugin.on_job_finished(job, result, config)
    _drain_status_queue(plugin)

    adapter.delete_message.assert_not_called()
    adapter.send.assert_called_once_with(config, "12345", "Quick answer")


def test_on_job_started_resets_status():
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")

    # Set stale state from a prior job.
    plugin._status_msg_id = "old"
    plugin._status_chat_id = "99999"
    plugin._last_status_time = 123.0

    plugin.on_job_started(job, config)

    assert plugin._status_msg_id == ""
    assert plugin._status_chat_id == ""
    assert plugin._last_status_time == 0.0


def test_on_job_finished_error_no_response():
    """When the agent fails with no response, send a generic error."""
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")

    result = AgentResult(exit_code=1, response="")
    plugin.on_job_finished(job, result, config)
    _drain_status_queue(plugin)

    adapter.send.assert_called_once_with(config, "12345", "Something went wrong.")


def test_on_job_finished_error_with_response():
    """When the agent fails but has a response (e.g. rate limit text), send it."""
    plugin, adapter = _make_plugin()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")

    result = AgentResult(
        exit_code=1,
        response="You've hit your limit - resets 1am (UTC)",
    )
    plugin.on_job_finished(job, result, config)
    _drain_status_queue(plugin)

    # The response text is sent (not the generic error).
    adapter.send.assert_called_once_with(
        config, "12345", "You've hit your limit - resets 1am (UTC)",
    )


def test_on_agent_output_returns_before_slow_status_send():
    """Slow Telegram status sends must not block stdout event handling."""
    from hivemoot_agent.plugins_builtin.messaging import MessagingPlugin

    started = threading.Event()
    release = threading.Event()

    class SlowAdapter:
        def send_and_get_id(self, config, chat_id, text):
            started.set()
            release.wait(timeout=2)
            return "42"

        def edit_message(self, config, chat_id, message_id, text):
            return True

        def delete_message(self, config, chat_id, message_id):
            return True

        def send(self, config, chat_id, text):
            return True

        def typing(self, config, chat_id):
            return True

    plugin = MessagingPlugin()
    plugin._platform_adapter = SlowAdapter()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")
    event = AgentEvent(kind="assistant_message", text="Let me look into this for you")

    plugin.on_job_started(job, config)
    start = time.monotonic()
    plugin.on_agent_output(job, event, config)
    elapsed = time.monotonic() - start

    assert elapsed < 0.2
    assert started.wait(timeout=1.0)

    release.set()
    _drain_status_queue(plugin)


def test_on_job_finished_returns_before_slow_status_delete():
    """Final replies must not wait for best-effort status cleanup."""
    from hivemoot_agent.plugins_builtin.messaging import MessagingPlugin

    started = threading.Event()
    release = threading.Event()
    sends: list[tuple[str, str]] = []

    class SlowAdapter:
        def send_and_get_id(self, config, chat_id, text):
            return "42"

        def edit_message(self, config, chat_id, message_id, text):
            return True

        def delete_message(self, config, chat_id, message_id):
            started.set()
            release.wait(timeout=2)
            return True

        def send(self, config, chat_id, text):
            sends.append((chat_id, text))
            return True

        def typing(self, config, chat_id):
            return True

    plugin = MessagingPlugin()
    plugin._platform_adapter = SlowAdapter()
    job = Job(session_key="tg:12345", prompt="hello")
    config = PluginConfig(name="messaging")
    plugin._status_msg_id = "42"
    plugin._status_chat_id = "12345"
    plugin._status_closed = False

    start = time.monotonic()
    plugin.on_job_finished(job, AgentResult(exit_code=0, response="Final answer"), config)
    elapsed = time.monotonic() - start

    assert elapsed < 0.2
    assert sends == [("12345", "Final answer")]
    assert started.wait(timeout=1.0)

    release.set()
    _drain_status_queue(plugin)


def test_send_and_get_id_falls_back_to_plain_text_on_http_parse_error():
    from hivemoot_agent.plugins_builtin.messaging.platforms.telegram import TelegramAdapter

    adapter = TelegramAdapter()
    config = PluginConfig(name="messaging", settings={"TELEGRAM_BOT_TOKEN": "x"})
    calls = []

    err_body = json.dumps(
        {"ok": False, "description": "Bad Request: can't parse entities"},
    ).encode()
    parse_error = urllib.error.HTTPError(
        "http://example.test",
        400,
        "Bad Request",
        hdrs=None,
        fp=io.BytesIO(err_body),
    )

    def fake_api(token, method, data=None):
        calls.append((method, data))
        if len(calls) == 1:
            raise parse_error
        return {"ok": True, "result": {"message_id": 42}}

    with patch(
        "hivemoot_agent.plugins_builtin.messaging.platforms.telegram._api",
        side_effect=fake_api,
    ):
        result = adapter.send_and_get_id(config, "12345", "**broken**")

    assert result == "42"
    assert calls == [
        ("sendMessage", {"chat_id": "12345", "text": "<b>broken</b>", "parse_mode": "HTML"}),
        ("sendMessage", {"chat_id": "12345", "text": "**broken**"}),
    ]


def test_edit_message_falls_back_to_plain_text_on_http_parse_error():
    from hivemoot_agent.plugins_builtin.messaging.platforms.telegram import TelegramAdapter

    adapter = TelegramAdapter()
    config = PluginConfig(name="messaging", settings={"TELEGRAM_BOT_TOKEN": "x"})
    calls = []

    err_body = json.dumps(
        {"ok": False, "description": "Bad Request: can't parse entities"},
    ).encode()
    parse_error = urllib.error.HTTPError(
        "http://example.test",
        400,
        "Bad Request",
        hdrs=None,
        fp=io.BytesIO(err_body),
    )

    def fake_api(token, method, data=None):
        calls.append((method, data))
        if len(calls) == 1:
            raise parse_error
        return {"ok": True}

    with patch(
        "hivemoot_agent.plugins_builtin.messaging.platforms.telegram._api",
        side_effect=fake_api,
    ):
        result = adapter.edit_message(config, "12345", "42", "**broken**")

    assert result is True
    assert calls == [
        (
            "editMessageText",
            {
                "chat_id": "12345",
                "message_id": "42",
                "text": "<b>broken</b>",
                "parse_mode": "HTML",
            },
        ),
        (
            "editMessageText",
            {"chat_id": "12345", "message_id": "42", "text": "**broken**"},
        ),
    ]


# ── MessagingTrigger offset tests ────────────────────────────────
#
# These test the fix for the infinite-retry-loop bug: when dispatch()
# returned False, the trigger did not advance the offset, causing it
# to re-poll and re-process the same user message forever — each
# iteration sending the error text to Telegram.


def _make_trigger():
    """Create a MessagingTrigger with a mock plugin/adapter."""
    from hivemoot_agent.plugins_builtin.messaging import MessagingPlugin
    from hivemoot_agent.plugins_builtin.messaging.trigger import MessagingTrigger

    plugin = MessagingPlugin()
    adapter = MagicMock()
    adapter.poll = MagicMock(return_value=[])
    adapter.typing = MagicMock(return_value=True)
    plugin._platform_adapter = adapter

    trigger = MessagingTrigger(plugin)
    return trigger, adapter


def _run_trigger_once(trigger, adapter, config, dispatcher, messages):
    """Run the trigger for one poll cycle, then stop.

    Sets up the adapter to return `messages` on the first poll,
    then empty on the second (which triggers the stop).
    """
    call_count = [0]
    def poll_side_effect(*args, **kwargs):
        call_count[0] += 1
        if call_count[0] == 1:
            return messages
        # Stop after processing the first batch.
        trigger.stop()
        return []

    adapter.poll = MagicMock(side_effect=poll_side_effect)
    trigger.start(config, dispatcher)


def test_trigger_advances_offset_on_success():
    """Offset advances when dispatch succeeds."""
    trigger, adapter = _make_trigger()
    config = PluginConfig(name="messaging", settings={
        "MESSAGING_AGENT_ID": "test",
        "MESSAGING_ALLOWED_CHAT_IDS": "12345",
    })
    dispatcher = MagicMock()
    dispatcher.dispatch = MagicMock(return_value=True)

    messages = [{"update_id": 100, "chat_id": "12345", "text": "hello"}]
    _run_trigger_once(trigger, adapter, config, dispatcher, messages)

    dispatcher.dispatch.assert_called_once()
    # Second poll should use advanced offset (101).
    second_poll_args = adapter.poll.call_args_list[1]
    assert second_poll_args[0][1] == 101  # offset arg


def test_trigger_advances_offset_on_dispatch_failure():
    """REGRESSION: Offset must advance even when dispatch fails.

    This is the bug that caused the infinite spam loop — when Claude
    hit a rate limit (exit_code != 0), dispatch returned False, the
    offset was not advanced, and the trigger re-processed the same
    message forever, sending the error text to Telegram each time.
    """
    trigger, adapter = _make_trigger()
    config = PluginConfig(name="messaging", settings={
        "MESSAGING_AGENT_ID": "test",
        "MESSAGING_ALLOWED_CHAT_IDS": "12345",
    })
    dispatcher = MagicMock()
    dispatcher.dispatch = MagicMock(return_value=False)  # Simulate failure

    messages = [{"update_id": 200, "chat_id": "12345", "text": "hello"}]
    _run_trigger_once(trigger, adapter, config, dispatcher, messages)

    dispatcher.dispatch.assert_called_once()
    # Critical: offset must still advance to 201, preventing re-poll.
    second_poll_args = adapter.poll.call_args_list[1]
    assert second_poll_args[0][1] == 201  # offset arg


def test_trigger_processes_multiple_messages_advancing_offset():
    """Multiple messages in one poll batch all get processed."""
    trigger, adapter = _make_trigger()
    config = PluginConfig(name="messaging", settings={
        "MESSAGING_AGENT_ID": "test",
        "MESSAGING_ALLOWED_CHAT_IDS": "12345",
    })
    dispatcher = MagicMock()
    # First dispatch succeeds, second fails.
    dispatcher.dispatch = MagicMock(side_effect=[True, False])

    messages = [
        {"update_id": 300, "chat_id": "12345", "text": "first"},
        {"update_id": 301, "chat_id": "12345", "text": "second"},
    ]
    _run_trigger_once(trigger, adapter, config, dispatcher, messages)

    assert dispatcher.dispatch.call_count == 2
    # Offset should be past both messages (302).
    second_poll_args = adapter.poll.call_args_list[1]
    assert second_poll_args[0][1] == 302


def test_trigger_skips_empty_text():
    """Messages without text are skipped (offset still advances)."""
    trigger, adapter = _make_trigger()
    config = PluginConfig(name="messaging", settings={
        "MESSAGING_AGENT_ID": "test",
        "MESSAGING_ALLOWED_CHAT_IDS": "12345",
    })
    dispatcher = MagicMock()

    messages = [{"update_id": 400, "chat_id": "12345", "text": ""}]
    _run_trigger_once(trigger, adapter, config, dispatcher, messages)

    dispatcher.dispatch.assert_not_called()
    # Offset still advances past the skipped message.
    second_poll_args = adapter.poll.call_args_list[1]
    assert second_poll_args[0][1] == 401


def test_trigger_denies_unauthorized_chat():
    """Messages from non-allowed chats are skipped (offset still advances)."""
    trigger, adapter = _make_trigger()
    config = PluginConfig(name="messaging", settings={
        "MESSAGING_AGENT_ID": "test",
        "MESSAGING_ALLOWED_CHAT_IDS": "12345",
    })
    dispatcher = MagicMock()

    messages = [{"update_id": 500, "chat_id": "99999", "text": "hello"}]
    _run_trigger_once(trigger, adapter, config, dispatcher, messages)

    dispatcher.dispatch.assert_not_called()
    second_poll_args = adapter.poll.call_args_list[1]
    assert second_poll_args[0][1] == 501


if __name__ == "__main__":
    import inspect

    passed = 0
    failed = 0
    for name, func in sorted(
        inspect.getmembers(sys.modules[__name__], inspect.isfunction)
    ):
        if not name.startswith("test_"):
            continue
        try:
            func()
            print(f"  \u2713 {name}")
            passed += 1
        except Exception as e:
            print(f"  \u2717 {name}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
