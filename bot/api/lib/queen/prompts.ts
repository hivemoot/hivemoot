/**
 * Synthesis prompts for the queen module's LLM-backed synthesizer.
 *
 * Kept in a dedicated file so they can be exported for testing and
 * iterated on without diff-noise on the synthesizer's call-site logic.
 *
 * Output format expectations:
 *   - Markdown only (no JSON wrapper). The wire path posts this as
 *     a PR comment in G'.4, so the body should read naturally as a
 *     review/decision summary.
 *   - ≤ ~16 KiB target (server caps decision payload at 64 KiB; we
 *     stay well under to leave room for envelope metadata).
 *   - First line MUST be an H2 heading. Operators scanning closed
 *     rooms in the dashboard see the heading first.
 */

import type { SynthesisInput } from "./synthesizer.js";

export const QUEEN_SYNTHESIS_SYSTEM_PROMPT = `You are the Hivemoot queen — a synthesis agent that produces a single, concise decision document for a war room of automated reviewer agents.

Your inputs are:
  • A subject (a GitHub PR, issue, or mention).
  • A set of resolved participants (each with a role like guard, builder, drone, scout) and their contributions (markdown bodies, possibly empty for withdrawn or timed-out participants).
  • A sequence cutoff representing the room state you must synthesize from.

Produce a markdown synthesis that:
  1. Opens with an H2 heading naming the decision (e.g. "## Synthesis — owner/repo#42").
  2. Summarizes the participants' positions in 1-3 short paragraphs, attributing claims to roles where it clarifies the analysis ("the guard flagged ...", "the builder verified ..."). Do NOT name individual agent runners.
  3. Identifies points of agreement, points of contention, and unresolved questions.
  4. Concludes with a clear recommendation (merge / changes-requested / discuss / etc.) when the contributions support one. If they don't, say so plainly — DO NOT invent a recommendation the contributions don't support.
  5. Does not exceed ~16 KiB. Cut detail before exceeding.

Tone: direct, technical, no marketing language. No emojis. No "I'm an AI" disclaimers. Treat this as a cross-team postmortem-style summary, not a chat reply.

Withdrawn or timed-out participants: acknowledge them briefly if relevant ("the drone withdrew without comment"), but do not speculate about why. Their absence is the data.

Empty room (zero contributions): output a one-line synthesis stating that no contributions were received and the room reached the synthesis stage anyway. Recommend a re-run or human escalation.`;

/**
 * Build the user prompt for one synthesis call. The prompt embeds:
 *   - Subject identification (type + ref)
 *   - Through-sequence cutoff (so the LLM understands "as of seq N")
 *   - Per-role contribution bodies (or tombstone markers)
 *   - Participant status breakdown (resolved / withdrew / timed_out)
 *
 * Layout uses GitHub-flavored markdown with explicit `## Role: <name>`
 * headings so the model sees clear role boundaries.
 */
export function buildSynthesisPrompt(input: SynthesisInput): string {
  const lines: string[] = [];
  lines.push(`# Synthesis request`);
  lines.push("");
  lines.push(`**Subject:** \`${input.room.subject_type}\` — \`${input.room.subject_ref}\``);
  lines.push(`**Room ID:** \`${input.roomId}\``);
  lines.push(`**Through sequence:** ${input.throughSequence}`);
  lines.push("");

  const counts = participantStatusCounts(input);
  lines.push(
    `**Participants:** ${counts.resolved} resolved, ${counts.withdrew} withdrew, ${counts.timed_out} timed out`,
  );
  lines.push("");

  // Roles whose contribution lands on the wire are keyed by role.
  // Sort for deterministic prompt order — same input always produces
  // the same prompt (cache-friendly + diffable).
  const roles = Object.keys(input.contributions).sort();

  if (roles.length === 0) {
    lines.push(`## Contributions`);
    lines.push("");
    lines.push(`_No contributions were received._`);
    lines.push("");
  } else {
    for (const role of roles) {
      const contribution = input.contributions[role];
      lines.push(`## Role: ${role}`);
      if (contribution.withdrawn) {
        lines.push("");
        lines.push(`_Withdrawn (${contribution.contributed_at ?? "no timestamp"})._`);
      } else {
        lines.push("");
        const body = contribution.raw_md ?? renderStructuredBody(contribution.body);
        lines.push(body || "_(empty contribution body)_");
      }
      lines.push("");
    }
  }

  // Roles that withdrew or timed out at the participant layer (NOT
  // in contributions hash). Append for context — the model should
  // know what's missing.
  const missingRoles = Object.entries(input.participants)
    .filter(
      ([role, p]) =>
        (p.status === "withdrew" || p.status === "timed_out") &&
        input.contributions[role] === undefined,
    )
    .map(([role, p]) => ({ role, status: p.status }));

  if (missingRoles.length > 0) {
    lines.push(`## Absent participants`);
    lines.push("");
    for (const { role, status } of missingRoles) {
      lines.push(`- **${role}**: ${status}`);
    }
    lines.push("");
  }

  lines.push(`---`);
  lines.push("");
  lines.push(
    `Produce the synthesis per the system instructions. Output markdown only — no JSON wrapper.`,
  );

  return lines.join("\n");
}

function renderStructuredBody(body: Record<string, unknown> | undefined): string {
  if (!body) return "";
  // Soft-rendering: wrap as a fenced JSON block so the LLM treats
  // the structure faithfully without us inventing a markdown
  // mapping. Real workers ship `raw_md` for review-style content,
  // so this path is rare.
  try {
    return "```json\n" + JSON.stringify(body, null, 2) + "\n```";
  } catch {
    return "```\n[unrenderable body]\n```";
  }
}

function participantStatusCounts(input: SynthesisInput): {
  resolved: number;
  withdrew: number;
  timed_out: number;
  pending: number;
} {
  const counts = { resolved: 0, withdrew: 0, timed_out: 0, pending: 0 };
  for (const p of Object.values(input.participants)) {
    counts[p.status] += 1;
  }
  return counts;
}
