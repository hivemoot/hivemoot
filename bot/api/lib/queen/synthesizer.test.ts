/**
 * Tests for `StubSynthesizer` (G'.2). The real LLM-backed
 * synthesizer arrives in G'.3 and gets its own test suite.
 */

import { describe, expect, it } from "vitest";
import { StubSynthesizer, type SynthesisInput } from "./synthesizer.js";
import type {
  RoomContribution,
  RoomCoreResponse,
  RoomParticipant,
} from "../war-room-client.js";

const ROOM: RoomCoreResponse = {
  manager: "bot-queen",
  subject_type: "pr_review",
  subject_ref: "owner/repo#42",
  status: "deciding",
  opened_at: "2026-04-28T20:00:00Z",
};

const PARTICIPANT: RoomParticipant = {
  agent_id: "guard-runner-1",
  role: "guard",
  status: "resolved",
  rsvp_at: "2026-04-28T20:01:00Z",
  resolved_at: "2026-04-28T20:05:00Z",
};

const PRESENT_CONTRIBUTION: RoomContribution = {
  raw_md: "Looks good.",
  contributed_at: "2026-04-28T20:05:00Z",
};

const WITHDRAWN: RoomContribution = {
  withdrawn: true,
  contributed_at: "2026-04-28T20:06:00Z",
};

describe("StubSynthesizer", () => {
  const synth = new StubSynthesizer();

  it("returns markdown including the roomId, subject, throughSequence", async () => {
    const input: SynthesisInput = {
      roomId: "01234567-89ab-4cde-9012-3456789abcde",
      room: ROOM,
      participants: { guard: PARTICIPANT },
      contributions: { guard: PRESENT_CONTRIBUTION },
      throughSequence: 7,
    };
    const out = await synth.synthesize(input);
    expect(out.content).toContain("01234567-89ab-4cde-9012-3456789abcde");
    expect(out.content).toContain("pr_review");
    expect(out.content).toContain("owner/repo#42");
    expect(out.content).toContain("Through sequence:** 7");
  });

  it("counts present vs withdrawn contributions separately", async () => {
    const input: SynthesisInput = {
      roomId: "room-id",
      room: ROOM,
      participants: { guard: PARTICIPANT, builder: PARTICIPANT },
      contributions: {
        guard: PRESENT_CONTRIBUTION,
        builder: WITHDRAWN,
      },
      throughSequence: 5,
    };
    const out = await synth.synthesize(input);
    expect(out.content).toContain("1 present, 1 withdrawn");
  });

  it("handles zero contributions gracefully", async () => {
    const input: SynthesisInput = {
      roomId: "room-id",
      room: ROOM,
      participants: {},
      contributions: {},
      throughSequence: 0,
    };
    const out = await synth.synthesize(input);
    expect(out.content).toContain("0 present, 0 withdrawn");
  });

  it("breaks down participants by status (R1 #536 guard NB4)", async () => {
    // Prior label `Participants resolved: ${total}` counted withdrew
    // + timed_out as "resolved" — wrong on the wire. New shape:
    // `${resolved} resolved, ${withdrew} withdrew, ${timed_out} timed out`.
    const input: SynthesisInput = {
      roomId: "room-id",
      room: ROOM,
      participants: {
        guard: { ...PARTICIPANT, role: "guard", status: "resolved" },
        builder: {
          ...PARTICIPANT,
          role: "builder",
          status: "withdrew",
          withdrew_at_sequence: 5,
        },
        drone: { ...PARTICIPANT, role: "drone", status: "timed_out" },
      },
      contributions: { guard: PRESENT_CONTRIBUTION },
      throughSequence: 5,
    };
    const out = await synth.synthesize(input);
    expect(out.content).toContain("1 resolved, 1 withdrew, 1 timed out");
  });

  it("flags itself as stub mode in the body", async () => {
    // The body must clearly identify itself as stub output so an
    // operator scanning closed-room decisions can confirm the queen
    // hasn't yet been wired to a real LLM. G'.3 replaces this with
    // real synthesis output.
    const out = await synth.synthesize({
      roomId: "x",
      room: ROOM,
      participants: {},
      contributions: {},
      throughSequence: 0,
    });
    expect(out.content).toContain("stub");
    expect(out.content).toContain("G'.3");
  });
});
