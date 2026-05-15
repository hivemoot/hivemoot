"""Local queen feature block for the consolidated hivemoot plugin."""

from __future__ import annotations

from hivemoot_agent.plugins_builtin.hivemoot.queen.api import (
    ClaimedSynthesis,
    QueenAPIConflictError,
    ResolveActionResult,
    SealDecisionResult,
    SynthesisReadyRoom,
)
from hivemoot_agent.plugins_builtin.hivemoot.queen.handler import (
    JOB_KIND_SYNTHESIS,
    build_seal_header,
    handle_queen_job_finished,
    is_queen_job,
    parse_decision_output,
)
from hivemoot_agent.plugins_builtin.hivemoot.queen.trigger import (
    LocalQueenSynthesisTrigger,
)


__all__ = (
    "ClaimedSynthesis",
    "JOB_KIND_SYNTHESIS",
    "LocalQueenSynthesisTrigger",
    "QueenAPIConflictError",
    "ResolveActionResult",
    "SealDecisionResult",
    "SynthesisReadyRoom",
    "build_seal_header",
    "handle_queen_job_finished",
    "is_queen_job",
    "parse_decision_output",
)
