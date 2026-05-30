"""Tests for apiarist.core.ipc — framing + envelope parsing."""

from __future__ import annotations

import json
import struct

import pytest

from apiarist.core.ipc import (
    LENGTH_PREFIX_BYTES,
    LENGTH_PREFIX_FORMAT,
    MAX_PAYLOAD_BYTES,
    ErrorCode,
    ErrorResponse,
    FramingError,
    ProtocolError,
    Request,
    SuccessResponse,
    decode_request,
    encode_message,
)


def test_error_codes_are_uppercase_snake() -> None:
    # If we add a new code that doesn't fit the convention, future
    # serialization (logs, metrics) will be inconsistent. Pin it here.
    for name in dir(ErrorCode):
        if name.startswith("_"):
            continue
        value = getattr(ErrorCode, name)
        assert isinstance(value, str) and value == name, (name, value)


# ---------------------------------------------------------------------------
# encode_message
# ---------------------------------------------------------------------------


def test_encode_round_trips() -> None:
    payload = {"hello": "world", "n": 42}
    framed = encode_message(payload)
    assert len(framed) >= LENGTH_PREFIX_BYTES
    (length,) = struct.unpack(LENGTH_PREFIX_FORMAT, framed[:LENGTH_PREFIX_BYTES])
    body = framed[LENGTH_PREFIX_BYTES:]
    assert len(body) == length
    assert json.loads(body) == payload


def test_encode_rejects_oversize_payload() -> None:
    huge = {"x": "y" * (MAX_PAYLOAD_BYTES + 1)}
    with pytest.raises(FramingError, match="exceeds cap"):
        encode_message(huge)


def test_encode_handles_unicode() -> None:
    payload = {"msg": "héllo wörld 🐝"}
    framed = encode_message(payload)
    body = framed[LENGTH_PREFIX_BYTES:]
    assert json.loads(body) == payload


# ---------------------------------------------------------------------------
# decode_request
# ---------------------------------------------------------------------------


def test_decode_minimal_request() -> None:
    body = json.dumps({"op": "health", "request_id": "abc"}).encode("utf-8")
    req = decode_request(body)
    assert req == Request(op="health", params={}, request_id="abc")


def test_decode_with_params() -> None:
    body = json.dumps(
        {"op": "mint_token", "request_id": "x", "params": {"service": "s", "repo": "r"}}
    ).encode("utf-8")
    req = decode_request(body)
    assert req.op == "mint_token"
    assert req.params == {"service": "s", "repo": "r"}


def test_decode_rejects_non_json() -> None:
    with pytest.raises(ProtocolError, match="JSON"):
        decode_request(b"not json")


def test_decode_rejects_non_utf8() -> None:
    with pytest.raises(ProtocolError, match="UTF-8"):
        decode_request(b"\xff\xfe not utf-8")


def test_decode_rejects_non_object_top_level() -> None:
    with pytest.raises(ProtocolError, match="JSON object"):
        decode_request(b'["array", "instead"]')


@pytest.mark.parametrize("missing", ["op", "request_id"])
def test_decode_rejects_missing_required_field(missing: str) -> None:
    body = {"op": "health", "request_id": "x"}
    del body[missing]
    with pytest.raises(ProtocolError, match=missing):
        decode_request(json.dumps(body).encode())


def test_decode_rejects_empty_op() -> None:
    body = json.dumps({"op": "", "request_id": "x"}).encode()
    with pytest.raises(ProtocolError, match="op"):
        decode_request(body)


def test_decode_rejects_non_object_params() -> None:
    body = json.dumps({"op": "health", "request_id": "x", "params": "string"}).encode()
    with pytest.raises(ProtocolError, match="params"):
        decode_request(body)


# ---------------------------------------------------------------------------
# Response envelopes
# ---------------------------------------------------------------------------


def test_success_response_to_wire() -> None:
    out = SuccessResponse(request_id="r1", data={"k": "v"}).to_wire()
    assert out == {"request_id": "r1", "ok": True, "data": {"k": "v"}}


def test_error_response_to_wire_known_request_id() -> None:
    out = ErrorResponse(request_id="r1", code=ErrorCode.UNKNOWN_OP, message="nope").to_wire()
    assert out == {
        "request_id": "r1",
        "ok": False,
        "error": {"code": "UNKNOWN_OP", "message": "nope"},
    }


def test_error_response_handles_unknown_request_id() -> None:
    # When the request body itself was malformed, request_id may be
    # unrecoverable. Wire shape should still be valid.
    out = ErrorResponse(
        request_id=None, code=ErrorCode.BAD_REQUEST, message="parse failed"
    ).to_wire()
    assert out["request_id"] is None
    assert out["ok"] is False
