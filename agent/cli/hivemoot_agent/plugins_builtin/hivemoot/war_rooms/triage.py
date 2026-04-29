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
        "Investigate the subject (use your normal review tools — gh CLI, "
        "code search, etc.) and produce a structured triage decision per "
        "the output format below. If the subject is genuinely outside "
        "your role's purview, withdraw cleanly rather than contributing "
        "a low-signal review."
    )
    lines.append("")
    lines.append(TRIAGE_OUTPUT_INSTRUCTIONS)
    return "\n".join(lines)


# ── Parser ─────────────────────────────────────────────────────────


_DECISION_RE = re.compile(r"^DECISION:\s*([A-Z_]+)\s*$", re.MULTILINE)
_VERDICT_RE = re.compile(r"^VERDICT:\s*([A-Z_]+)\s*$", re.MULTILINE)
_SUMMARY_RE = re.compile(r"^SUMMARY:\s*(.+)$", re.MULTILINE)
_REASON_RE = re.compile(r"^REASON:\s*(.+)$", re.MULTILINE)
# Body section: everything from `## Review` (case-insensitive) to end
# of string. Captured non-greedily up to optional trailing whitespace.
_BODY_RE = re.compile(
    r"^##\s+Review\s*\n(.*?)\s*$", re.MULTILINE | re.DOTALL | re.IGNORECASE
)
# The triage block must come last; we look for the LAST occurrence
# of a "## Triage decision" heading so the agent can think out loud
# in earlier sections without confusing the parser.
_TRIAGE_HEADER_RE = re.compile(
    r"^##\s+Triage\s+decision\s*$", re.MULTILINE | re.IGNORECASE
)


def parse_triage_response(markdown: str) -> TriageDecision:
    """Parse the agent's response into a structured `TriageDecision`.

    Robust to:
      - Trailing whitespace / extra blank lines
      - Earlier sections containing the markers (we only look at
        the LAST `## Triage decision` block)
      - Missing optional fields (REASON on WITHDRAW)

    Synthesizes a WITHDRAW with `parse_error=True` on:
      - Empty / whitespace-only response
      - No `## Triage decision` heading
      - Missing or invalid DECISION
      - DECISION=PRESENT with missing/invalid VERDICT
      - DECISION=PRESENT with missing SUMMARY
    """
    if not markdown or not markdown.strip():
        return _withdraw_parse_error("empty_response")

    triage_block = _slice_last_triage_block(markdown)
    if triage_block is None:
        return _withdraw_parse_error("no_triage_heading")

    decision_match = _DECISION_RE.search(triage_block)
    if decision_match is None:
        return _withdraw_parse_error("no_decision_marker")
    decision = decision_match.group(1).strip()

    if decision == "WITHDRAW":
        reason_match = _REASON_RE.search(triage_block)
        reason = reason_match.group(1).strip() if reason_match else None
        return TriageDecision(kind="withdraw", reason=reason)

    if decision != "PRESENT":
        return _withdraw_parse_error(f"invalid_decision:{decision[:32]}")

    # PRESENT path — verdict + summary required.
    verdict_match = _VERDICT_RE.search(triage_block)
    if verdict_match is None:
        return _withdraw_parse_error("missing_verdict")
    verdict = verdict_match.group(1).strip()
    if verdict not in VALID_VERDICTS:
        return _withdraw_parse_error(f"invalid_verdict:{verdict[:32]}")

    summary_match = _SUMMARY_RE.search(triage_block)
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
