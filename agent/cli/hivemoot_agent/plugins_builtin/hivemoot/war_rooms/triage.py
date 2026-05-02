"""War-room triage prompt + response parser (F.3).

The watcher trigger (F.2) dispatches one Job per visible room. The
engine subprocess (claude / codex / etc.) runs the triage prompt
returned here, then the on_job_finished handler parses the response
to decide whether to PRESENT (RSVP + submit a contribution) or
WITHDRAW.

# Output contract

The agent MUST produce markdown ending with two sections:

```
## Triage decision

DECISION: PRESENT
VERDICT: REQUEST_CHANGES
SUMMARY: <1-2 sentence summary>

## Review

<full markdown analysis>
```

Or for withdrawal:

```
## Triage decision

DECISION: WITHDRAW
REASON: <one-line explanation>
```

The line-prefix format is chosen over YAML/JSON blocks because:
  - LLMs reliably produce simple "KEY: value" lines.
  - Parsing is robust against incidental whitespace, fenced code
    blocks elsewhere in the response, and trailing chatter.
  - VERDICT enum matches WAR_ROOM_DESIGN.md §S2 exactly so the
    queen's structural-floor aggregation reads it as-validated.

# Failure modes (parser side)

Any malformed response (missing/invalid DECISION, missing VERDICT
when PRESENT, etc.) is treated as WITHDRAW with reason
`unparseable_triage_output:<class>`. The handler chooses safety: a
worker that produces garbage doesn't get to inject into the queen's
synthesis input via raw_md.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import api as wr_api


__all__ = (
    "TRIAGE_OUTPUT_INSTRUCTIONS",
    "TriageDecision",
    "build_triage_prompt",
    "parse_triage_response",
)


VALID_VERDICTS: frozenset[str] = frozenset(
    {"APPROVE", "COMMENT", "CONCERNS", "REQUEST_CHANGES"}
)


# Embedded into the user prompt so every dispatched Job sees the
# exact same output spec. Kept as a module constant so tests can
# assert on its content without re-tokenizing the full prompt.
TRIAGE_OUTPUT_INSTRUCTIONS = """\
## Output format (MUST follow exactly)

End your response with one of two structured blocks:

**To contribute a review:**
```
## Triage decision

DECISION: PRESENT
VERDICT: <APPROVE | COMMENT | CONCERNS | REQUEST_CHANGES>
SUMMARY: <1-2 sentence summary, ≤500 chars>

## Review

<your full markdown analysis here>
```

**To skip this room (out of scope, no useful input, etc.):**
```
## Triage decision

DECISION: WITHDRAW
REASON: <one-line explanation>
```

Rules:
- DECISION must be exactly `PRESENT` or `WITHDRAW`.
- VERDICT (when PRESENT) must be one of the four enum values literal,
  uppercase. The queen aggregates these structurally per
  WAR_ROOM_DESIGN.md §S2 — APPROVE for clean, REQUEST_CHANGES for
  blockers, CONCERNS for non-blocking issues that warrant pause,
  COMMENT for FYI / unscoped observations.
- SUMMARY is the one-line headline of your review; the queen
  may surface this verbatim to the PR.
- The Review section is your full prose analysis — anything you'd
  normally include in a PR review comment (line refs, severities,
  remediation suggestions). The queen treats this as untrusted PR-
  derived content and isolates it inside `<untrusted-content>`
  delimiters before passing to its own LLM, so don't bother with
  prompt-injection probes — they won't reach the synthesis LLM
  unfiltered."""


@dataclass(frozen=True)
class TriageDecision:
    """Parsed structured output of the triage agent.

    `kind`: "present" or "withdraw". When parsing fails, kind is
    "withdraw" with `reason` set to a sentinel `"unparseable_…"`
    string and `parse_error=True` so the handler can log distinctly.

    For "present" decisions, `verdict` and `summary` are validated
    populated. `body` is the markdown content of the Review section
    (may be empty if the agent forgot to include one).
    """

    kind: str  # "present" | "withdraw"
    # Present-only:
    verdict: str | None = None  # one of VALID_VERDICTS when kind="present"
    summary: str | None = None
    body: str | None = None
    # Withdraw-only:
    reason: str | None = None
    # Set when the parser failed and synthesized a withdraw.
    parse_error: bool = False


def build_triage_prompt(room: wr_api.WatchingRoom) -> str:
    """Construct the user prompt the engine runs for this room.

    Inputs the agent gets:
      - Room identification (subject + ref + roomId)
      - Status + sequence (so re-dispatched rooms see new state)
      - Current participants (so the agent sees who else is in)
      - The output-format spec

    The agent's persistent system prompt — set by the role plugin
    elsewhere — already instructs it on its review style, repo
    paths, available tools, etc. The triage prompt purposefully
    does NOT re-state that; it focuses on what's room-specific.
    """
    lines: list[str] = []
    lines.append("# War-room triage")
    lines.append("")
    lines.append(
        f"You've been surfaced into a war room for **{room.subject_type}** `{room.subject_ref}`. "
        f"Decide whether to contribute a review or withdraw."
    )
    lines.append("")
    lines.append(f"**Room ID:** `{room.room_id}`")
    lines.append(f"**Status:** `{room.status}`")
    lines.append(f"**Sequence (at dispatch):** {room.current_sequence}")
    if room.manager:
        lines.append(f"**Opened by:** `{room.manager}`")
    lines.append("")

    if room.participants:
        lines.append("## Other participants in this room")
        lines.append("")
        for role, p in sorted(room.participants.items()):
            status = (p or {}).get("status", "?")
            lines.append(f"- **{role}**: `{status}`")
        lines.append("")
    else:
        lines.append("_No other participants have RSVPd yet — you're early._")
        lines.append("")

    lines.append("## Your task")
    lines.append("")
    lines.append(
        "Investigate the subject efficiently — budget yourself ~3-5 tool "
        "calls (gh CLI, file reads, code search) and then emit the "
        "structured triage block.  If the subject is genuinely outside "
        "your role's purview, OR if the investigation is dragging, "
        "withdraw cleanly with a brief reason rather than contributing a "
        "low-signal review."
    )
    lines.append("")
    lines.append(
        "**Critical:** the triage block at the BOTTOM of the output "
        "format below is REQUIRED.  Produce it before your response "
        "ends, even if the investigation is incomplete.  A clean "
        "WITHDRAW with reason `incomplete_investigation` (or similar) "
        "is acceptable; a response that gets truncated mid-tool-call "
        "with no triage block at all is NOT — the queen treats that as "
        "a parse error and your role is dropped from the synthesis "
        "input entirely."
    )
    lines.append("")
    lines.append(TRIAGE_OUTPUT_INSTRUCTIONS)
    return "\n".join(lines)


# ── Parser ─────────────────────────────────────────────────────────
#
# All key regexes are intentionally permissive on incidentals (case,
# leading markdown bullets / blockquote markers / bold emphasis,
# trailing whitespace) so that a model that emits `**Decision:** present`
# or `> DECISION: PRESENT` or `* decision: present` instead of the
# canonical `DECISION: PRESENT` still parses cleanly.  The verdict
# value itself is upper-cased before validation against
# `VALID_VERDICTS`, so `verdict: approve` works too.  Keeping these
# loose costs nothing — the canonical instructions in
# `TRIAGE_OUTPUT_INSTRUCTIONS` still ask for the strict form, so most
# models produce it; the relaxed regex just rescues the edge cases
# (e.g. zai/glm-5.1 occasionally bolds the keys).


# Optional leading markup: blockquote `>`, list bullet `* / - / +`,
# or markdown bold/italic prefix `*` / `_`.  The trailing markup
# brackets cover both `**DECISION**: VAL` (bold around key only) and
# `**DECISION:** VAL` (bold around key+colon) — both are valid
# markdown and observed in the wild.
_PRE = r"[>*_\-+\s]*"           # before key
_MID_KEY_TO_COLON = r"[*_]*"    # between key and `:` (closes a `**KEY**` bold)
_MID_COLON_TO_VAL = r"[*_\s]*"  # between `:` and value (closes a `**KEY:**` bold)
_POST = r"[\s*_]*"              # trailing markup after value


_DECISION_RE = re.compile(
    rf"^{_PRE}DECISION{_MID_KEY_TO_COLON}:{_MID_COLON_TO_VAL}([A-Za-z_]+){_POST}$",
    re.MULTILINE | re.IGNORECASE,
)
_VERDICT_RE = re.compile(
    rf"^{_PRE}VERDICT{_MID_KEY_TO_COLON}:{_MID_COLON_TO_VAL}([A-Za-z_]+){_POST}$",
    re.MULTILINE | re.IGNORECASE,
)
_SUMMARY_RE = re.compile(
    rf"^{_PRE}SUMMARY{_MID_KEY_TO_COLON}:{_MID_COLON_TO_VAL}(.+?){_POST}$",
    re.MULTILINE | re.IGNORECASE,
)
_REASON_RE = re.compile(
    rf"^{_PRE}REASON{_MID_KEY_TO_COLON}:{_MID_COLON_TO_VAL}(.+?){_POST}$",
    re.MULTILINE | re.IGNORECASE,
)
# Body section: everything from `## Review` (case-insensitive) to end
# of string. Captured non-greedily up to optional trailing whitespace.
_BODY_RE = re.compile(
    r"^##\s+Review\s*\n(.*?)\s*$", re.MULTILINE | re.DOTALL | re.IGNORECASE
)
# The triage block normally comes last; we look for the LAST
# occurrence of a "## Triage decision" heading so the agent can think
# out loud in earlier sections without confusing the parser.  The
# heading is OPTIONAL — see `parse_triage_response` for the fallback
# when no heading is present but DECISION markers exist anyway.
_TRIAGE_HEADER_RE = re.compile(
    r"^##\s+Triage\s+decision\s*$", re.MULTILINE | re.IGNORECASE
)


def parse_triage_response(markdown: str) -> TriageDecision:
    """Parse the agent's response into a structured `TriageDecision`.

    Robust to:
      - Trailing whitespace / extra blank lines
      - Earlier sections containing the markers (we prefer the LAST
        `## Triage decision` block, but fall back to scanning the full
        document when no heading exists — covers models that emit
        bare DECISION/VERDICT markers without the markdown header)
      - Case variations (`Decision:`, `decision:`, `DECISION:`)
      - Markdown decoration (`**DECISION:**`, `> DECISION:`, `* DECISION:`)
      - Lowercase verdict values (`approve`, `Concerns` → uppercased)
      - Missing optional fields (REASON on WITHDRAW)

    Synthesizes a WITHDRAW with `parse_error=True` on:
      - Empty / whitespace-only response
      - No DECISION marker anywhere in the response
      - DECISION=PRESENT with missing/invalid VERDICT
      - DECISION=PRESENT with missing SUMMARY
    """
    if not markdown or not markdown.strip():
        return _withdraw_parse_error("empty_response")

    # Prefer the LAST `## Triage decision` block when one exists —
    # avoids picking up a tentative draft from earlier prose.
    triage_block = _slice_last_triage_block(markdown)
    # Fallback: if no header, scan the whole document.  Closes the
    # case where a model emits `DECISION: PRESENT` / `VERDICT: ...`
    # bare at the end without the `## Triage decision` header (zai
    # has been observed to skip the header when its response is
    # truncated mid-format).
    haystack = triage_block if triage_block is not None else markdown

    decision_match = _DECISION_RE.search(haystack)
    if decision_match is None:
        # No decision anywhere — distinguish "had heading but missing
        # marker" from "no heading either" so operators can grep for
        # which mode is failing.
        return _withdraw_parse_error(
            "no_decision_marker" if triage_block is not None else "no_triage_heading",
        )
    decision = decision_match.group(1).strip().upper()

    if decision == "WITHDRAW":
        reason_match = _REASON_RE.search(haystack)
        reason = reason_match.group(1).strip() if reason_match else None
        return TriageDecision(kind="withdraw", reason=reason)

    if decision != "PRESENT":
        return _withdraw_parse_error(f"invalid_decision:{decision[:32]}")

    # PRESENT path — verdict + summary required.
    verdict_match = _VERDICT_RE.search(haystack)
    if verdict_match is None:
        return _withdraw_parse_error("missing_verdict")
    verdict = verdict_match.group(1).strip().upper()
    if verdict not in VALID_VERDICTS:
        return _withdraw_parse_error(f"invalid_verdict:{verdict[:32]}")

    summary_match = _SUMMARY_RE.search(haystack)
    if summary_match is None:
        return _withdraw_parse_error("missing_summary")
    summary = summary_match.group(1).strip()
    if not summary:
        return _withdraw_parse_error("empty_summary")
    if len(summary) > 500:
        # Server-side cap. Truncate cleanly rather than rejecting —
        # an over-long summary is an ergonomics failure, not a safety
        # one (the verdict is structural).
        summary = summary[:497] + "…"

    body_match = _BODY_RE.search(markdown)
    body = body_match.group(1).strip() if body_match else ""

    return TriageDecision(
        kind="present",
        verdict=verdict,
        summary=summary,
        body=body,
    )


def _slice_last_triage_block(markdown: str) -> str | None:
    """Return the text from the LAST `## Triage decision` heading
    onward, OR None if no such heading exists. Avoids false-positive
    matches from earlier prose that mentions the marker."""
    matches = list(_TRIAGE_HEADER_RE.finditer(markdown))
    if not matches:
        return None
    return markdown[matches[-1].end():]


def _withdraw_parse_error(reason: str) -> TriageDecision:
    return TriageDecision(
        kind="withdraw",
        reason=f"unparseable_triage_output:{reason}",
        parse_error=True,
    )
