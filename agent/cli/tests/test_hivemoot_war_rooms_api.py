"""Tests for cli/hivemoot_agent/plugins_builtin/hivemoot/war_rooms/api.py."""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins_builtin.hivemoot.war_rooms import api as wr_api
from hivemoot_agent.plugins_builtin.hivemoot import http as hm_http


def _fake_response(status: int = 200, body: bytes = b"") -> MagicMock:
    cm = MagicMock()
    resp = cm.__enter__.return_value
    resp.status = status
    resp.read.return_value = body
    cm.__exit__.return_value = False
    return cm


class ListWatchingRoomsTests(unittest.TestCase):
    """GET /api/rooms/watching parsing."""

    def test_returns_empty_when_rooms_array_missing(self) -> None:
        body = json.dumps({}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            self.assertEqual(
                wr_api.list_watching_rooms("https://api.example", "tok"),
                [],
            )

    def test_returns_empty_when_rooms_array_empty(self) -> None:
        body = json.dumps({"rooms": []}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            self.assertEqual(
                wr_api.list_watching_rooms("https://api.example", "tok"),
                [],
            )

    def test_parses_full_room_response(self) -> None:
        room_id = "01234567-89ab-4cde-9012-3456789abcde"
        body = json.dumps({
            "rooms": [
                {
                    "core": {
                        "roomId": room_id,
                        "status": "awaiting_contributions",
                        "subject_type": "pr_review",
                        "subject_ref": "hivemoot/hivemoot#42",
                        "manager": "bot-queen",
                        "opened_at": "2026-04-28T07:00:00.000Z",
                    },
                    "participants": {
                        "drone": {
                            "agent_id": "drone-1",
                            "role": "drone",
                            "status": "pending",
                            "rsvp_at": "2026-04-28T07:01:00.000Z",
                        },
                    },
                    "currentSequence": 5,
                },
            ],
        }).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            result = wr_api.list_watching_rooms("https://api.example", "tok")
        self.assertEqual(len(result), 1)
        room = result[0]
        self.assertEqual(room.room_id, room_id)
        self.assertEqual(room.status, "awaiting_contributions")
        self.assertEqual(room.subject_ref, "hivemoot/hivemoot#42")
        self.assertEqual(room.current_sequence, 5)
        self.assertIn("drone", room.participants)

    def test_skips_non_dict_entries_silently(self) -> None:
        room_id = "01234567-89ab-4cde-9012-3456789abcde"
        body = json.dumps({
            "rooms": [
                "not-an-object",
                {"core": {"roomId": room_id, "status": "awaiting_rsvp",
                          "subject_type": "pr_review", "subject_ref": "x/y#1",
                          "manager": "m", "opened_at": "t"},
                 "participants": {}, "currentSequence": 1},
            ],
        }).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            result = wr_api.list_watching_rooms("https://api.example", "tok")
        self.assertEqual(len(result), 1)

    def test_raises_on_missing_room_id(self) -> None:
        body = json.dumps({
            "rooms": [{
                "core": {"status": "awaiting_rsvp"},
                "participants": {},
                "currentSequence": 0,
            }],
        }).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            with self.assertRaises(RuntimeError) as cm:
                wr_api.list_watching_rooms("https://api.example", "tok")
        self.assertIn("missing core.roomId", str(cm.exception))

    def test_raises_on_non_200(self) -> None:
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(403, b"forbidden"),
        ):
            with self.assertRaises(RuntimeError) as cm:
                wr_api.list_watching_rooms("https://api.example", "tok")
        self.assertIn("status 403", str(cm.exception))

    def test_raises_on_non_object_body(self) -> None:
        body = b"[]"
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            with self.assertRaises(RuntimeError) as cm:
                wr_api.list_watching_rooms("https://api.example", "tok")
        self.assertIn("not a JSON object", str(cm.exception))

    def test_strips_trailing_slash_from_base_url(self) -> None:
        body = json.dumps({"rooms": []}).encode()
        captured = {}

        def fake_open(req, timeout):  # type: ignore[no-untyped-def]
            captured["url"] = req.full_url
            return _fake_response(200, body)

        with patch.object(hm_http._OPENER, "open", side_effect=fake_open):
            wr_api.list_watching_rooms("https://api.example/", "tok")
        self.assertEqual(captured["url"], "https://api.example/api/rooms/watching")


class PresentToRoomTests(unittest.TestCase):
    """POST /api/rooms/{id}/present semantics."""

    ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde"

    def test_happy_path_returns_sequence(self) -> None:
        body = json.dumps({"sequence": 5}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            result = wr_api.present_to_room(
                "https://api.example", self.ROOM_ID, 1, "tok",
            )
        self.assertEqual(result, 5)

    def test_includes_intent_hint_when_provided(self) -> None:
        body = json.dumps({"sequence": 1}).encode()
        captured = {}

        def fake_open(req, timeout):  # type: ignore[no-untyped-def]
            captured["body"] = req.data
            return _fake_response(200, body)

        with patch.object(hm_http._OPENER, "open", side_effect=fake_open):
            wr_api.present_to_room(
                "https://api.example", self.ROOM_ID, 3, "tok",
                intent_hint="review for security",
            )
        sent = json.loads(captured["body"])
        self.assertEqual(sent["intentHint"], "review for security")
        self.assertEqual(sent["sequenceObservedByClient"], 3)

    def test_omits_intent_hint_when_none(self) -> None:
        body = json.dumps({"sequence": 1}).encode()
        captured = {}

        def fake_open(req, timeout):  # type: ignore[no-untyped-def]
            captured["body"] = req.data
            return _fake_response(200, body)

        with patch.object(hm_http._OPENER, "open", side_effect=fake_open):
            wr_api.present_to_room(
                "https://api.example", self.ROOM_ID, 3, "tok",
            )
        sent = json.loads(captured["body"])
        self.assertNotIn("intentHint", sent)

    def test_raises_on_409_owner_conflict(self) -> None:
        body = json.dumps({"code": "owner_conflict"}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(409, body),
        ):
            with self.assertRaises(RuntimeError) as cm:
                wr_api.present_to_room(
                    "https://api.example", self.ROOM_ID, 1, "tok",
                )
        self.assertIn("status 409", str(cm.exception))

    def test_raises_on_response_missing_sequence(self) -> None:
        body = json.dumps({}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            with self.assertRaises(RuntimeError) as cm:
                wr_api.present_to_room(
                    "https://api.example", self.ROOM_ID, 1, "tok",
                )
        self.assertIn("invalid `sequence`", str(cm.exception))


class SubmitContributionTests(unittest.TestCase):
    ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde"

    def test_happy_path_returns_sequence(self) -> None:
        body = json.dumps({"sequence": 8}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            result = wr_api.submit_contribution(
                "https://api.example",
                self.ROOM_ID,
                5,
                {"verdict": "APPROVE", "summary": "ok"},
                "# Verdict\n\nApprove.",
                "tok",
            )
        self.assertEqual(result, 8)

    def test_sends_full_body_shape(self) -> None:
        body = json.dumps({"sequence": 1}).encode()
        captured = {}

        def fake_open(req, timeout):  # type: ignore[no-untyped-def]
            captured["body"] = req.data
            return _fake_response(200, body)

        contribution_body = {
            "verdict": "REQUEST_CHANGES",
            "summary": "needs work",
            "findings": [{"area": "security", "severity": "blocker"}],
        }
        with patch.object(hm_http._OPENER, "open", side_effect=fake_open):
            wr_api.submit_contribution(
                "https://api.example",
                self.ROOM_ID,
                3,
                contribution_body,
                "raw markdown body",
                "tok",
            )
        sent = json.loads(captured["body"])
        self.assertEqual(sent["sequenceObservedByClient"], 3)
        self.assertEqual(sent["body"], contribution_body)
        self.assertEqual(sent["rawMd"], "raw markdown body")

    def test_raises_on_400_validation_error(self) -> None:
        body = json.dumps({"code": "invalid_contribution_body"}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(400, body),
        ):
            with self.assertRaises(RuntimeError):
                wr_api.submit_contribution(
                    "https://api.example",
                    self.ROOM_ID,
                    1,
                    {"verdict": "approve"},  # lowercase = invalid
                    "x",
                    "tok",
                )


class WithdrawParticipantTests(unittest.TestCase):
    ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde"

    def test_happy_path_returns_sequence(self) -> None:
        body = json.dumps({"sequence": 4}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(200, body),
        ):
            result = wr_api.withdraw_participant(
                "https://api.example", self.ROOM_ID, 2, "tok",
            )
        self.assertEqual(result, 4)

    def test_includes_reason_when_provided(self) -> None:
        body = json.dumps({"sequence": 1}).encode()
        captured = {}

        def fake_open(req, timeout):  # type: ignore[no-untyped-def]
            captured["body"] = req.data
            return _fake_response(200, body)

        with patch.object(hm_http._OPENER, "open", side_effect=fake_open):
            wr_api.withdraw_participant(
                "https://api.example", self.ROOM_ID, 1, "tok",
                reason="out of scope",
            )
        sent = json.loads(captured["body"])
        self.assertEqual(sent["reason"], "out of scope")


class RoomStateRaceErrorTests(unittest.TestCase):
    """The /present, /contributions, and /withdraw POST helpers
    must distinguish 409 `status_precondition_failed` (the room
    moved on while the worker was triaging — benign race) from
    other 409s and other failures, so the handler can log the race
    at info level instead of WARN/ERROR.  Without this distinction
    operator log volume is high enough to mask real errors."""

    ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde"

    def _race_409(self) -> bytes:
        return json.dumps({
            "code": "status_precondition_failed",
            "message": "room is currently 'deciding'",
        }).encode()

    def test_present_raises_RoomStateRaceError_on_409_status_precondition_failed(
        self,
    ) -> None:
        with patch.object(
            hm_http._OPENER,
            "open",
            return_value=_fake_response(409, self._race_409()),
        ):
            with self.assertRaises(wr_api.RoomStateRaceError) as cm:
                wr_api.present_to_room(
                    "https://api.example", self.ROOM_ID, 1, "tok",
                )
        self.assertEqual(cm.exception.op, "present")
        self.assertEqual(cm.exception.code, "status_precondition_failed")
        # RoomStateRaceError is itself a RuntimeError so existing
        # callers that catch the broader type still match.
        self.assertIsInstance(cm.exception, RuntimeError)

    def test_contributions_raises_RoomStateRaceError_on_race(self) -> None:
        with patch.object(
            hm_http._OPENER,
            "open",
            return_value=_fake_response(409, self._race_409()),
        ):
            with self.assertRaises(wr_api.RoomStateRaceError) as cm:
                wr_api.submit_contribution(
                    "https://api.example",
                    self.ROOM_ID,
                    1,
                    {"verdict": "APPROVE", "summary": "ok"},
                    "# body",
                    "tok",
                )
        self.assertEqual(cm.exception.op, "contributions")

    def test_withdraw_raises_RoomStateRaceError_on_race(self) -> None:
        with patch.object(
            hm_http._OPENER,
            "open",
            return_value=_fake_response(409, self._race_409()),
        ):
            with self.assertRaises(wr_api.RoomStateRaceError) as cm:
                wr_api.withdraw_participant(
                    "https://api.example", self.ROOM_ID, 1, "tok",
                    reason="out of scope",
                )
        self.assertEqual(cm.exception.op, "withdraw")

    def test_other_409_codes_still_raise_generic_RuntimeError(self) -> None:
        # owner_conflict, participant_already_present, etc. are
        # distinct race classes that the handler treats differently.
        # They MUST NOT collapse into RoomStateRaceError.
        body = json.dumps({"code": "owner_conflict"}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(409, body),
        ):
            with self.assertRaises(RuntimeError) as cm:
                wr_api.present_to_room(
                    "https://api.example", self.ROOM_ID, 1, "tok",
                )
        self.assertNotIsInstance(cm.exception, wr_api.RoomStateRaceError)
        self.assertIn("status 409", str(cm.exception))

    def test_409_without_recognizable_code_still_raises_generic(self) -> None:
        body = json.dumps({"message": "no code field"}).encode()
        with patch.object(
            hm_http._OPENER, "open", return_value=_fake_response(409, body),
        ):
            with self.assertRaises(RuntimeError) as cm:
                wr_api.present_to_room(
                    "https://api.example", self.ROOM_ID, 1, "tok",
                )
        self.assertNotIsInstance(cm.exception, wr_api.RoomStateRaceError)


class GetJsonTransportTests(unittest.TestCase):
    """Sanity checks on the new shared `get_json` helper that the
    war-room watcher depends on. Mirrors the post_json invariants."""

    def test_refuses_non_http_scheme(self) -> None:
        with self.assertRaises(ValueError):
            hm_http.get_json("file:///etc/passwd", "tok")

    def test_refuses_redirect_to_protect_bearer(self) -> None:
        # _NoRedirectHandler raises on 301/302/303/307/308. The
        # _OPENER under test is the same singleton, so any GET that
        # hits a redirect would surface as an HTTPError.
        import urllib.error
        cm = MagicMock()
        cm.__enter__.side_effect = urllib.error.HTTPError(
            "https://api.example/x", 302,
            "redirect not followed (would leak Authorization): Found",
            {}, None,
        )
        with patch.object(hm_http._OPENER, "open", return_value=cm):
            status, parsed, raw = hm_http.get_json(
                "https://api.example/x", "tok",
            )
        self.assertEqual(status, 302)


if __name__ == "__main__":
    unittest.main()
