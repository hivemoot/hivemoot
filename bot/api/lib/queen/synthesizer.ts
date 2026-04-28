/**
 * Synthesizer — abstraction over the queen's decision-generation
 * step.
 *
 * The manager loop (G'.2) reads a room's participants + contributions
 * after claiming the synthesis lane, hands them to a `Synthesizer`,
 * and writes the resulting markdown back via `closeRoom`. The
 * abstraction is here so:
 *
 *   1. **G'.3** can swap a real LLM synthesizer (`AiSdkSynthesizer`)
 *      in without touching the loop's claim/close mechanics.
 *   2. **Tests** can use a `StubSynthesizer` (no LLM calls, fast,
 *      deterministic) to exercise the loop end-to-end.
 *
 * The synthesizer NEVER calls the war-room API directly — it
 * receives all room state through `SynthesisInput` and returns the
 * decision body. The manager loop is the only thing that crosses
 * the wire. This separation is what makes G'.3 a focused PR
 * (LLM-call wiring only) rather than a re-plumb.
 */

import type {
  RoomCoreResponse,
  RoomContribution,
  RoomParticipant,
} from "../war-room-client.js";

/**
 * Everything the synthesizer needs to produce a decision. The
 * manager loop materializes this from the war-room client's reads
 * (`getRoomCore` + `getRoomParticipants` + `getRoomContributions`)
 * AFTER `claimSynthesis` succeeds — so `throughSequence` is the
 * cutoff seq the close path will verify.
 */
export interface SynthesisInput {
  roomId: string;
  /** Room core record (manager, subject, status, opened_at, etc.). */
  room: RoomCoreResponse;
  /** Materialized participant hash (role → state). All participants
   * in `awaiting_contributions` are guaranteed `resolved` by the
   * loop's eligibility check before this is invoked. */
  participants: Record<string, RoomParticipant>;
  /** Materialized contribution hash (role → body or tombstone). */
  contributions: Record<string, RoomContribution>;
  /** The sequence the queen claimed through. Future events past this
   * cutoff are ignored; close-time drift detection compares
   * `expectedThroughSequence` (= this) against the live seq. */
  throughSequence: number;
}

export interface SynthesisOutput {
  /** The decision body — markdown, ≤ 64 KiB UTF-8 bytes per the
   * server's `RoomDecisionTooLargeError` cap. Synthesizers that risk
   * exceeding this should truncate (or return a structured error
   * the loop maps to a `failed_synthesis` terminate — V1.1). */
  content: string;
}

export interface Synthesizer {
  synthesize(input: SynthesisInput): Promise<SynthesisOutput>;
}

/**
 * StubSynthesizer — placeholder that returns a deterministic
 * markdown body without calling any LLM. Used by the manager loop's
 * tests AND by the production deployment until G'.3 ships the real
 * synthesizer (so the queen route can be wired + cron exercised
 * end-to-end before the LLM dependency lands).
 *
 * The body includes enough context (roomId, participant + contribution
 * counts, throughSequence) that operators can confirm the loop ran
 * by inspecting closed rooms, without the body looking like a real
 * decision.
 */
export class StubSynthesizer implements Synthesizer {
  async synthesize(input: SynthesisInput): Promise<SynthesisOutput> {
    const participantCount = Object.keys(input.participants).length;
    const contributionCount = Object.values(input.contributions).filter(
      (c) => !c.withdrawn,
    ).length;
    const withdrawnCount = Object.values(input.contributions).filter(
      (c) => c.withdrawn,
    ).length;
    const lines = [
      `## Synthesis (stub — G'.3 replaces this with real LLM)`,
      "",
      `**Room:** \`${input.roomId}\``,
      `**Subject:** ${input.room.subject_type} \`${input.room.subject_ref}\``,
      `**Through sequence:** ${input.throughSequence}`,
      "",
      `**Participants resolved:** ${participantCount}`,
      `**Contributions:** ${contributionCount} present, ${withdrawnCount} withdrawn`,
      "",
      `_The queen module is operating in stub mode; this room was synthesized by the manager loop without invoking an LLM. See WAR_ROOM_DESIGN.md and Phase G'.3._`,
    ];
    return { content: lines.join("\n") };
  }
}
