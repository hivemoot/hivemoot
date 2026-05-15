"""Prompt builder for the local queen synthesis job."""

from __future__ import annotations

import json
from typing import Any

from hivemoot_agent.plugins_builtin.hivemoot.queen.api import (
    ClaimedSynthesis,
)


__all__ = ("build_synthesis_prompt",)


def build_synthesis_prompt(
    *,
    claimed: ClaimedSynthesis,
    reviewed_head_sha: str,
) -> str:
    payload: dict[str, Any] = {
        "room_id": claimed.room_id,
        "sealed_through_sequence": claimed.through_sequence,
        "reviewed_head_sha": reviewed_head_sha,
        "room": claimed.room,
        "participants": claimed.participants,
        "contributions": claimed.contributions,
    }
    room_json = json.dumps(payload, indent=2, sort_keys=True, default=str)

    return f"""# Local Queen Synthesis

You are the Hivemoot local queen for a PR review war room. Synthesize the
participants' contributions into one public PR comment.

Important constraints:
- Use only the room payload below as evidence.
- The reviewed PR head SHA is `{reviewed_head_sha}`.
- This runner slice is comment-close only. Set `recommended_action` to `comment`.
- Do not include any `hivemoot:queen-action` seal header; the runner adds it.
- Keep the public comment concise, specific, and actionable.

Return exactly one fenced JSON block and no other prose:

```json
{{
  "verdict": "APPROVE",
  "reasoning": "Short explanation, 500 chars max.",
  "recommended_action": "comment",
  "comment_body": "Markdown body to post publicly on the PR."
}}
```

Valid verdicts: APPROVE, COMMENT, CONCERNS, REQUEST_CHANGES.

Room payload:

```json
{room_json}
```
"""
