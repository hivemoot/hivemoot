"""War-room triage prompt + response handling.

The watcher trigger dispatches one Job per visible room. The engine
subprocess (claude / codex / etc.) runs the triage prompt returned
here, then the on_job_finished handler treats the engine's full
markdown output as the contribution payload.

# Design (post the simplification away from structured output)

Earlier the agent had to emit a strict `DECISION:` / `VERDICT:` /
`SUMMARY:` block; the parser extracted those fields and the queen
aggregated structurally per WAR_ROOM_DESIGN.md §S2.  That was the
right shape for verdict-flow (PR review / mention response / issue
triage) but a poor fit for any other room type (e.g. operator-created
`general` rooms): the agent was forced to fabricate a verdict on a
non-verdictable subject, withdrew on parse error, and the watcher
re-dispatched in a noisy loop.

The new contract is *agents always produce free-form markdown*; the
queen's LLM derives the verdict via forced structured tool-call
output (Zod-enum schema, separate PR).  This file keeps:

  - `build_triage_prompt(room)` — same signature, generic prompt,
    no rigid output spec, no tool budget hint.
  - `TriageDecision` — same dataclass shape so existing call sites
    keep typechecking, but `kind` is always `"present"` for a
    successful run; `verdict` / `summary` are always `None`; `body`
    carries the full agent output verbatim.
  - `parse_triage_response(text)` — a thin identity: returns a
    present decision with the full text as `body`.  Empty input
    is the only failure mode and surfaces as a withdraw with reason
    `empty_response`.

The structured `body.verdict` field on the contribution payload is
*omitted* by the handler going forward.  The shared validator was
relaxed in the same PR series to make `body.verdict` + `body.summary`
optional.
"""

from __future__ import annotations

from dataclasses import dataclass

from . import api as wr_api


__all__ = (
    "TriageDecision",
    "build_triage_prompt",
    "parse_triage_response",
)


@dataclass(frozen=True)
class TriageDecision:
    """Result of processing the agent's response.

    Post-simplification semantics:
      - `kind == "present"` for any non-empty agent output; `body`
        carries the full markdown, `verdict` / `summary` are `None`
        (queen LLM derives the verdict from `body`).
      - `kind == "withdraw"` only when the engine produced no usable
        output at all; `reason="empty_response"` and
        `parse_error=True`.
    """

    kind: str  # "present" | "withdraw"
    # Present-only:
    verdict: str | None = None
    summary: str | None = None
    body: str | None = None
    # Withdraw-only:
    reason: str | None = None
    # Set when the engine produced no usable output.
    parse_error: bool = False


def build_triage_prompt(room: wr_api.WatchingRoom) -> str:
    """Construct the user prompt the engine runs for this room.

    The prompt is intentionally generic across subject types — it
    hands the agent the full room metadata and lets the agent's
    role-level system prompt (set by the role plugin elsewhere)
    decide how to engage.  No rigid output format, no tool-call
    budget, no required `DECISION:` block: whatever the agent
    emits goes verbatim into `body.raw_md` for the queen to
    synthesize.
    """
    lines: list[str] = []
    lines.append("# War-room participation")
    lines.append("")
    lines.append(
        f"You've been surfaced into a war room for **{room.subject_type}** "
        f"`{room.subject_ref}`. Contribute your perspective in markdown."
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
        lines.append("_No other participants have RSVP'd yet — you're early._")
        lines.append("")

    lines.append("## Your task")
    lines.append("")
    lines.append(
        "Investigate the subject however makes sense for your role and the "
        "room type. Use whatever tools and depth fit. When you're ready, "
        "produce a markdown analysis of what you found — your opinion, "
        "concerns, things you noticed, suggestions, questions. Whatever "
        "is genuinely useful for the room's purpose."
    )
    lines.append("")
    lines.append(
        "The queen synthesizer will read your full output and aggregate it "
        "with other participants' contributions, deriving the room-level "
        "decision via its own structured-output LLM call. You don't need to "
        "pick a verdict or follow any specific output format — just write "
        "the analysis."
    )
    lines.append("")
    lines.append(
        "If after investigation you have nothing useful to add (room is "
        "outside your role's scope, no signal to surface), say so plainly "
        "in one or two lines. The queen will treat that as a meaningful "
        "input — \"this role looked and found nothing actionable\" — rather "
        "than dropping you from the synthesis."
    )
    return "\n".join(lines)


def parse_triage_response(text: str) -> TriageDecision:
    """Wrap the agent's full output as a present-with-body decision.

    The agent's markdown is treated as the contribution verbatim.
    The only failure path is an entirely empty engine response; that
    surfaces as a withdraw with reason ``empty_response`` so operators
    can grep worker logs for engines that aren't responding at all.
    """
    if text is None or text.strip() == "":
        return TriageDecision(
            kind="withdraw",
            reason="empty_response",
            parse_error=True,
        )
    return TriageDecision(kind="present", body=text)
