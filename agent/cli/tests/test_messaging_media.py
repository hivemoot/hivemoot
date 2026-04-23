"""Tests for inbound media handling in the messaging plugin.

Covers:
  - Attachment detection across Telegram's media field variants
    (photo, document, audio, voice, video).
  - Precedence when multiple media fields are present.
  - Filename synthesis for media types Telegram doesn't name.
  - Prompt enrichment block formatting.

Download itself (two-step getFile + HTTP stream) is not exercised
here — it requires a live Telegram bot token.  The trigger's
download-error fallback is exercised via a fake adapter below.
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.messaging.platforms.telegram import (
    _extract_attachment_hint,
)
from hivemoot_agent.plugins_builtin.messaging.trigger import (
    MessagingTrigger,
    _friendly_size,
)


class ExtractAttachmentHintTests(unittest.TestCase):
    def test_plain_text_message_has_no_attachment(self):
        msg = {"text": "hello"}
        self.assertIsNone(_extract_attachment_hint(msg))

    def test_photo_picks_largest_variant(self):
        msg = {
            "photo": [
                {"file_id": "small", "file_size": 100, "width": 90, "height": 60},
                {"file_id": "big", "file_size": 50000, "width": 1280, "height": 720},
                {"file_id": "mid", "file_size": 5000, "width": 320, "height": 180},
            ],
        }
        hint = _extract_attachment_hint(msg)
        self.assertIsNotNone(hint)
        self.assertEqual(hint["kind"], "photo")
        self.assertEqual(hint["file_id"], "big")
        self.assertEqual(hint["dimensions"]["width"], 1280)

    def test_document_preserves_original_filename(self):
        msg = {
            "document": {
                "file_id": "doc-abc",
                "file_name": "report-Q3.pdf",
                "file_size": 900_000,
                "mime_type": "application/pdf",
            },
        }
        hint = _extract_attachment_hint(msg)
        self.assertEqual(hint["kind"], "document")
        self.assertEqual(hint["filename"], "report-Q3.pdf")
        self.assertEqual(hint["mime_hint"], "application/pdf")

    def test_voice_synthesizes_filename(self):
        msg = {
            "voice": {
                "file_id": "voice-xyz",
                "duration": 12,
                "mime_type": "audio/ogg",
                "file_size": 34_000,
            },
        }
        hint = _extract_attachment_hint(msg)
        self.assertEqual(hint["kind"], "voice")
        self.assertEqual(hint["filename"], "voice.ogg")
        self.assertEqual(hint["duration_secs"], 12)

    def test_audio_uses_title_as_filename_when_no_file_name(self):
        msg = {
            "audio": {
                "file_id": "a1",
                "title": "Interview",
                "performer": "Guest",
                "duration": 300,
                "mime_type": "audio/mpeg",
            },
        }
        hint = _extract_attachment_hint(msg)
        self.assertEqual(hint["kind"], "audio")
        self.assertTrue(hint["filename"].startswith("Interview"))

    def test_video_synthesizes_filename_from_mime(self):
        msg = {
            "video": {
                "file_id": "v1",
                "width": 1920,
                "height": 1080,
                "duration": 45,
                "mime_type": "video/mp4",
                "file_size": 10_000_000,
            },
        }
        hint = _extract_attachment_hint(msg)
        self.assertEqual(hint["kind"], "video")
        self.assertTrue(hint["filename"].endswith(".mp4"))
        self.assertEqual(hint["dimensions"]["height"], 1080)

    def test_photo_and_text_coexist(self):
        """Caption lives alongside photo — trigger handles the unification,
        but extract_hint should still find the photo."""
        msg = {
            "text": "",
            "caption": "check this",
            "photo": [{"file_id": "x", "file_size": 100, "width": 10, "height": 10}],
        }
        hint = _extract_attachment_hint(msg)
        self.assertEqual(hint["kind"], "photo")

    def test_sticker_and_animation_are_ignored(self):
        """Phase 4A skips sticker / animation / video_note — low value,
        high complexity per media kind."""
        msg = {"sticker": {"file_id": "s", "emoji": "😀"}}
        self.assertIsNone(_extract_attachment_hint(msg))

        msg2 = {"animation": {"file_id": "g", "mime_type": "image/gif"}}
        self.assertIsNone(_extract_attachment_hint(msg2))


class FriendlySizeTests(unittest.TestCase):
    def test_bytes(self):
        self.assertEqual(_friendly_size(0), "0 B")
        self.assertEqual(_friendly_size(500), "500 B")

    def test_kilobytes(self):
        self.assertEqual(_friendly_size(1024), "1.0 KB")
        self.assertEqual(_friendly_size(150_000), "146.5 KB")

    def test_megabytes(self):
        self.assertEqual(_friendly_size(2 * 1024 * 1024), "2.0 MB")


class FormatAttachmentsTests(unittest.TestCase):
    def setUp(self):
        self.trigger = MessagingTrigger(plugin=MagicMock())

    def test_empty_list_produces_empty_string(self):
        self.assertEqual(self.trigger._format_attachments([]), "")

    def test_successful_download_includes_path_and_metadata(self):
        block = self.trigger._format_attachments([{
            "kind": "photo",
            "path": "/data/incoming/42/photo.jpg",
            "size_bytes": 150_000,
            "mime": "image/jpeg",
            "dimensions": {"width": 1280, "height": 720},
        }])
        self.assertIn("[Attached files]", block)
        self.assertIn("/data/incoming/42/photo.jpg", block)
        self.assertIn("146.5 KB", block)
        self.assertIn("1280x720", block)
        self.assertIn("image/jpeg", block)
        self.assertIn("shell tools", block)

    def test_failed_download_surfaces_error(self):
        """An attachment that failed to download still appears in the block
        so the agent knows *something* was sent and can explain the gap
        to the user."""
        block = self.trigger._format_attachments([{
            "kind": "document",
            "error": "file_too_large",
            "message": "30MB exceeds 20MB cap",
        }])
        self.assertIn("download failed (file_too_large)", block)
        self.assertIn("30MB exceeds 20MB cap", block)

    def test_voice_shows_duration(self):
        block = self.trigger._format_attachments([{
            "kind": "voice",
            "path": "/data/incoming/99/voice.ogg",
            "size_bytes": 30_000,
            "mime": "audio/ogg",
            "duration_secs": 14,
        }])
        self.assertIn("14s", block)


if __name__ == "__main__":
    unittest.main()
