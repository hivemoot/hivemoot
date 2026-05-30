"""Length-prefixed JSON framing for the apiarist UDS protocol.

Each message on the wire is:

    | 4 bytes (big-endian uint32, payload length N) | N bytes UTF-8 JSON |

This is intentionally minimal — no version negotiation, no compression,
no optional fields beyond the JSON envelope. The framing is small enough
to implement in a few lines of bash + jq for the apiary controller (see
DESIGN.md §12.3) and trivial enough that protocol bugs are obvious.

Per-message payload is capped at MAX_PAYLOAD_BYTES (default 64 KiB) on
both read and write sides. A pathological client sending a 4 GiB length
prefix gets EOF'd at the cap, not allocated against.

Request shape (DESIGN.md §8):

    {
        "op": "<operation name>",
        "params": { ... operation-specific ... },
        "request_id": "<opaque correlation id>"
    }

Response shape — success:

    {
        "request_id": "<echoed>",
        "ok": true,
        "data": { ... operation-specific ... }
    }

Response shape — error:

    {
        "request_id": "<echoed if known, else null>",
        "ok": false,
        "error": { "code": "<UPPER_SNAKE>", "message": "<human readable>" }
    }

Error codes are defined in DESIGN.md §8 and live as constants on
`ErrorCode`. Server dispatch in `server.py` translates Python exceptions
from feature handlers into these wire codes.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any, Final

# Protocol constants. Tweaking these is a wire-breaking change; bump the
# DESIGN.md version when you do.
LENGTH_PREFIX_BYTES: Final[int] = 4
LENGTH_PREFIX_FORMAT: Final[str] = "!I"  # network byte order, unsigned 32-bit
MAX_PAYLOAD_BYTES: Final[int] = 64 * 1024  # 64 KiB — enough for any V1 op


class IPCError(Exception):
    """Base class for IPC framing/parsing errors raised on the server side.

    These are caught by `server.py` and translated into wire-level
    error envelopes. Callers should not let them propagate unhandled.
    """


class FramingError(IPCError):
    """Raised when the bytes on the wire don't form a valid framed message.

    Includes: short read on the length prefix, declared length above
    `MAX_PAYLOAD_BYTES`, short read on the body.
    """


class ProtocolError(IPCError):
    """Raised when the JSON parses but doesn't match the request schema.

    Includes: missing `op`, missing `request_id`, wrong types on the
    top-level envelope.
    """


# IPC error codes (DESIGN.md §8). Wire-level codes the server emits in
# the error envelope. Feature handlers raise typed exceptions; the
# dispatcher in `server.py` maps them to one of these.
class ErrorCode:
    BAD_REQUEST: Final[str] = "BAD_REQUEST"
    UNKNOWN_OP: Final[str] = "UNKNOWN_OP"
    BACKEND_UNAUTHORIZED: Final[str] = "BACKEND_UNAUTHORIZED"
    BACKEND_FORBIDDEN: Final[str] = "BACKEND_FORBIDDEN"
    BACKEND_RATE_LIMITED: Final[str] = "BACKEND_RATE_LIMITED"
    BACKEND_NOT_IMPLEMENTED: Final[str] = "BACKEND_NOT_IMPLEMENTED"
    BACKEND_PROTOCOL_ERROR: Final[str] = "BACKEND_PROTOCOL_ERROR"
    BACKEND_UNAVAILABLE: Final[str] = "BACKEND_UNAVAILABLE"
    INTERNAL: Final[str] = "INTERNAL"


@dataclass(frozen=True)
class Request:
    """One inbound request from a UDS client."""

    op: str
    params: dict[str, Any]
    request_id: str


@dataclass(frozen=True)
class SuccessResponse:
    """Successful op result. Renders to `{request_id, ok: true, data}`."""

    request_id: str
    data: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return {"request_id": self.request_id, "ok": True, "data": self.data}


@dataclass(frozen=True)
class ErrorResponse:
    """Error envelope. Renders to `{request_id, ok: false, error}`."""

    request_id: str | None
    code: str
    message: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "ok": False,
            "error": {"code": self.code, "message": self.message},
        }


# ---------------------------------------------------------------------------
# Wire encode / decode
# ---------------------------------------------------------------------------


def encode_message(payload: dict[str, Any]) -> bytes:
    """Serialize a payload dict into a length-prefixed JSON frame.

    Raises FramingError if the encoded payload exceeds MAX_PAYLOAD_BYTES.
    Callers should keep their response data small (V1 ops produce sub-KiB
    responses); the cap is a defense-in-depth check, not an expected
    failure mode.
    """
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_PAYLOAD_BYTES:
        raise FramingError(f"encoded payload {len(body)} bytes exceeds cap {MAX_PAYLOAD_BYTES}")
    return struct.pack(LENGTH_PREFIX_FORMAT, len(body)) + body


def decode_request(raw: bytes) -> Request:
    """Parse a JSON-decoded request body into a typed Request.

    Validates the envelope shape (op + request_id required, params optional
    and defaults to {}). Does NOT validate the params shape — that's the
    feature handler's responsibility.

    Raises ProtocolError on shape violations.
    """
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"request body is not valid UTF-8 JSON: {exc}") from exc

    if not isinstance(payload, dict):
        raise ProtocolError(f"request must be a JSON object (got {type(payload).__name__})")

    op = payload.get("op")
    request_id = payload.get("request_id")
    params_raw = payload.get("params", {})

    if not isinstance(op, str) or not op:
        raise ProtocolError("request missing required string field 'op'")
    if not isinstance(request_id, str) or not request_id:
        raise ProtocolError("request missing required string field 'request_id'")
    if not isinstance(params_raw, dict):
        raise ProtocolError(f"request 'params' must be an object (got {type(params_raw).__name__})")

    return Request(op=op, params=params_raw, request_id=request_id)
