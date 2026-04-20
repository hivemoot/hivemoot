"""Messaging trigger — polls a platform for inbound messages."""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Any

from hivemoot_agent.plugins.interfaces import Job, JobDispatcher, PluginConfig


# Where downloaded inbound attachments land inside the agent container.
# /data is already bind-mounted to /opt/apiary/data/<service>/ by
# deploy-apiary.sh, so files survive container restarts and the
# operator can inspect / clean them up from the host.  No automatic
# cleanup — operator's responsibility to rotate / purge older than N
# days.  Future work: a periodic cleanup task or on_job_finished
# lifecycle hook.
_INCOMING_MEDIA_ROOT = "/data/incoming"


def _friendly_size(n: int) -> str:
    """Human-readable byte count — for the prompt enrichment block."""
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


class MessagingTrigger:
    """Polls a messaging platform and dispatches jobs."""

    name = "messaging"

    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._stop_event = threading.Event()

    def validate(self, config: PluginConfig) -> list[str]:
        errors: list[str] = []
        if not config.get("MESSAGING_AGENT_ID"):
            errors.append("MESSAGING_AGENT_ID is required")
        return errors

    def _download_attachment(
        self,
        adapter: Any,
        config: PluginConfig,
        update_id: int,
        attachment: dict,
    ) -> dict | None:
        """Resolve an attachment hint into a downloaded file on disk.

        Returns a dict ``{kind, path, size_bytes, mime, ...}`` on
        success (merges hint metadata like dimensions / duration),
        or a dict ``{kind, error, message, ...}`` on failure — the
        caller surfaces both shapes in the prompt enrichment so the
        agent can reason about partial success (e.g. "Telegram sent
        three files, one was too big; here are the two that worked").

        Failures do NOT abort the job — a broken attachment shouldn't
        lose the user's caption / typed text.
        """
        file_id = attachment.get("file_id", "")
        if not file_id:
            return {
                "kind": attachment.get("kind", "unknown"),
                "error": "no_file_id",
                "message": "Telegram returned no file_id",
            }

        filename = attachment.get("filename", "attachment")
        dest_dir = Path(_INCOMING_MEDIA_ROOT) / str(update_id)
        dest_path = str(dest_dir / filename)

        result = adapter.download_file(config, file_id, dest_path)
        if not result.get("ok"):
            return {
                "kind": attachment.get("kind", "unknown"),
                "error": result.get("error", "download_failed"),
                "message": result.get("message", ""),
                "expected_size_bytes": attachment.get("size_hint", 0),
            }

        # Merge hint metadata (dimensions, duration) that only existed
        # in the poll payload; the adapter download result doesn't know
        # about it.
        merged = {
            "kind": attachment.get("kind", "file"),
            "path": result.get("path"),
            "size_bytes": result.get("size_bytes", 0),
            "mime": result.get("mime", attachment.get("mime_hint", "application/octet-stream")),
        }
        if "dimensions" in attachment:
            merged["dimensions"] = attachment["dimensions"]
        if "duration_secs" in attachment:
            merged["duration_secs"] = attachment["duration_secs"]
        return merged

    def _format_attachments(self, downloaded: list[dict]) -> str:
        """Compose the ``[Attached files]`` block appended to the agent prompt.

        Goal: give the agent enough information to decide whether /
        how to read each file via its existing shell tools (``cat``,
        ``pdftotext``, ``ffprobe``, image-capable providers reading the
        file directly, etc.).  Keep it compact — the agent doesn't
        need more than path + kind + size + mime per file.
        """
        if not downloaded:
            return ""
        lines = ["", "[Attached files]"]
        for item in downloaded:
            kind = item.get("kind", "file")
            if "error" in item:
                lines.append(
                    f"- {kind}: download failed ({item['error']}) — "
                    f"{item.get('message', '')}"
                )
                continue
            parts = [f"- {kind}: {item['path']}"]
            extras = []
            if item.get("size_bytes"):
                extras.append(_friendly_size(item["size_bytes"]))
            if item.get("mime"):
                extras.append(item["mime"])
            dims = item.get("dimensions") or {}
            if dims.get("width") and dims.get("height"):
                extras.append(f"{dims['width']}x{dims['height']}")
            if item.get("duration_secs"):
                extras.append(f"{item['duration_secs']}s")
            if extras:
                parts.append(f"({', '.join(extras)})")
            lines.append(" ".join(parts))
        lines.append(
            "Use your shell tools (cat, pdftotext, ffprobe, image readers) "
            "to inspect these files directly; they persist at the listed "
            "paths for this container's lifetime."
        )
        return "\n".join(lines)

    def start(self, config: PluginConfig, dispatcher: JobDispatcher) -> None:
        adapter = self._plugin.get_adapter()
        if adapter is None:
            print("[trigger] no adapter loaded", file=sys.stderr, flush=True)
            return

        allowed = set()
        allowed_raw = config.get("MESSAGING_ALLOWED_CHAT_IDS", "")
        if allowed_raw:
            allowed = {c.strip() for c in allowed_raw.split(",") if c.strip()}

        timeout = int(config.get("TELEGRAM_POLL_TIMEOUT_SECS", "30"))
        offset = 0
        self._stop_event.clear()

        print(
            f"[trigger] polling (offset={offset}, timeout={timeout}, "
            f"allowed={allowed})",
            file=sys.stderr, flush=True,
        )

        while not self._stop_event.is_set():
            messages = adapter.poll(config, offset, timeout)
            if messages:
                print(
                    f"[trigger] got {len(messages)} update(s)",
                    file=sys.stderr, flush=True,
                )

            for msg in messages:
                update_id = msg.get("update_id", 0)
                chat_id = msg.get("chat_id", "")
                text = msg.get("text", "")
                attachment = msg.get("attachment")

                print(
                    f"[trigger] id={update_id} chat={chat_id} "
                    f"text={text[:40]!r} attachment={attachment and attachment.get('kind')}",
                    file=sys.stderr, flush=True,
                )

                # A media-only message (photo with no caption, voice
                # note, forwarded document) has empty text but still
                # deserves dispatch.  Only skip when BOTH are missing.
                if not chat_id or (not text and not attachment):
                    print("[trigger] skip: no chat or no content", file=sys.stderr, flush=True)
                    offset = max(offset, update_id + 1)
                    continue

                if not allowed or chat_id not in allowed:
                    print(f"[trigger] deny: chat={chat_id}", file=sys.stderr, flush=True)
                    offset = max(offset, update_id + 1)
                    continue

                # Resolve attachments before dispatching.  One file per
                # message in Telegram's model; we still build a list so
                # future platforms with multi-attachment support can
                # extend the same path.
                downloaded: list[dict] = []
                if attachment:
                    downloaded.append(
                        self._download_attachment(adapter, config, update_id, attachment)
                    )

                enriched_prompt = text
                if downloaded:
                    enriched_prompt = (
                        (text or "[user sent media with no caption]")
                        + self._format_attachments(downloaded)
                    )

                print(f"[trigger] dispatching for chat={chat_id}", file=sys.stderr, flush=True)
                job = Job(session_key=f"tg:{chat_id}", prompt=enriched_prompt)

                # Always advance the offset — a failed run must never
                # cause the same user message to be re-processed, or
                # a persistent error creates an infinite spam loop.
                ok = dispatcher.dispatch(job)
                offset = max(offset, update_id + 1)
                if ok:
                    print(f"[trigger] ok, offset→{offset}", file=sys.stderr, flush=True)
                else:
                    print(f"[trigger] dispatch failed, offset→{offset}", file=sys.stderr, flush=True)

    def stop(self) -> None:
        self._stop_event.set()
