/**
 * Tests for the queen synthesis prompt templates (G'.3). The system
 * prompt is checked for spec coverage; the user prompt builder is
 * tested for each input shape variant (empty, withdrawn, structured
 * body, etc).
 */

import { describe, expect, it } from "vitest";
import {
  QUEEN_SYNTHESIS_SYSTEM_PROMPT,
  buildSynthesisPrompt,
} from "./prompts.js";
import type { SynthesisInput } from "./synthesizer.js";
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

const RESOLVED: RoomParticipant = {
  agent_id: "guard-runner",
  role: "guard",
  status: "resolved",
  rsvp_at: "2026-04-28T20:01:00Z",
  resolved_at: "2026-04-28T20:05:00Z",
};

describe("QUEEN_SYNTHESIS_SYSTEM_PROMPT", () => {
  it("instructs an H2 heading first line", () => {
    expect(QUEEN_SYNTHESIS_SYSTEM_PROMPT).toContain("H2 heading");
  });

  it("forbids inventing recommendations not supported by contributions", () => {
    expect(QUEEN_SYNTHESIS_SYSTEM_PROMPT).toMatch(
      /DO NOT invent a recommendation/i,
    );
  });

  it("forbids naming individual agent runners", () => {
    expect(QUEEN_SYNTHESIS_SYSTEM_PROMPT).toContain(
      "Do NOT name individual agent runners",
    );
  });

  it("targets a byte cap below storage's 64 KiB", () => {
    expect(QUEEN_SYNTHESIS_SYSTEM_PROMPT).toMatch(/16 KiB/i);
  });
});

describe("buildSynthesisPrompt", () => {
  it("includes subject + roomId + throughSequence", () => {
    const input: SynthesisInput = {
      roomId: "01234567-89ab-4cde-9012-3456789abcde",
      room: ROOM,
      participants: { guard: RESOLVED },
      contributions: { guard: { raw_md: "LGTM" } },
      throughSequence: 7,
    };
    const prompt = buildSynthesisPrompt(input);
    expect(prompt).toContain("01234567-89ab-4cde-9012-3456789abcde");
    expect(prompt).toContain("owner/repo#42");
    expect(prompt).toContain("Through sequence:** 7");
  });

  it("emits per-role headings sorted alphabetically (deterministic)", () => {
    const input: SynthesisInput = {
      roomId: "x",
      room: ROOM,
      participants: { drone: RESOLVED, builder: RESOLVED, guard: RESOLVED },
      contributions: {
        drone: { raw_md: "drone says" },
        builder: { raw_md: "builder says" },
        guard: { raw_md: "guard says" },
      },
      throughSequence: 1,
    };
    const prompt = buildSynthesisPrompt(input);
    const builderIdx = prompt.indexOf("Role: builder");
    const droneIdx = prompt.indexOf("Role: drone");
    const guardIdx = prompt.indexOf("Role: guard");
    // Alphabetical: builder < drone < guard.
    expect(builderIdx).toBeGreaterThan(0);
    expect(builderIdx).toBeLessThan(droneIdx);
    expect(droneIdx).toBeLessThan(guardIdx);
  });

  it("renders withdrawn contributions with a tombstone marker", () => {
    const tombstone: RoomContribution = {
      withdrawn: true,
      contributed_at: "2026-04-28T20:10:00Z",
    };
    const input: SynthesisInput = {
      roomId: "x",
      room: ROOM,
      participants: { guard: { ...RESOLVED, status: "withdrew" } },
      contributions: { guard: tombstone },
      throughSequence: 5,
    };
    const prompt = buildSynthesisPrompt(input);
    expect(prompt).toContain("Role: guard");
    expect(prompt).toContain("Withdrawn");
    expect(prompt).toContain("2026-04-28T20:10:00Z");
  });

  it("falls back to fenced JSON block when raw_md is absent", () => {
    const input: SynthesisInput = {
      roomId: "x",
      room: ROOM,
      participants: { guard: RESOLVED },
      contributions: {
        guard: { body: { decision: "approve", confidence: "high" } },
      },
      throughSequence: 1,
    };
    const prompt = buildSynthesisPrompt(input);
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"decision": "approve"');
  });

  it("emits 'no contributions' marker for an empty contribution hash", () => {
    const input: SynthesisInput = {
      roomId: "x",
      room: ROOM,
      participants: { guard: RESOLVED },
      contributions: {},
      throughSequence: 0,
    };
    const prompt = buildSynthesisPrompt(input);
    expect(prompt).toContain("No contributions were received");
  });

  it("appends an Absent participants section for withdrew/timed_out without contributions", () => {
    // Workers who withdraw at the participant layer (without ever
    // submitting) won't have an entry in the contributions hash.
    // The prompt must surface them so the LLM doesn't pretend they
    // weren't on the participant list.
    const input: SynthesisInput = {
      roomId: "x",
      room: ROOM,
      participants: {
        guard: RESOLVED,
        builder: { ...RESOLVED, status: "withdrew" },
        drone: { ...RESOLVED, status: "timed_out" },
      },
      contributions: { guard: { raw_md: "guard says" } },
      throughSequence: 1,
    };
    const prompt = buildSynthesisPrompt(input);
    expect(prompt).toContain("## Absent participants");
    expect(prompt).toContain("**builder**: withdrew");
    expect(prompt).toContain("**drone**: timed_out");
  });

  it("does NOT add Absent section when all participants contributed (or withdrew at contribution layer)", () => {
    const input: SynthesisInput = {
      roomId: "x",
      room: ROOM,
      participants: {
        guard: RESOLVED,
        builder: { ...RESOLVED, status: "withdrew" },
      },
      contributions: {
        guard: { raw_md: "guard says" },
        builder: { withdrawn: true, contributed_at: "x" },
      },
      throughSequence: 1,
    };
    const prompt = buildSynthesisPrompt(input);
    expect(prompt).not.toContain("Absent participants");
  });

  it("includes participant status counts", () => {
    const input: SynthesisInput = {
      roomId: "x",
      room: ROOM,
      participants: {
        guard: RESOLVED,
        builder: { ...RESOLVED, status: "withdrew" },
        drone: { ...RESOLVED, status: "timed_out" },
      },
      contributions: { guard: { raw_md: "x" } },
      throughSequence: 1,
    };
    const prompt = buildSynthesisPrompt(input);
    expect(prompt).toContain("1 resolved, 1 withdrew, 1 timed out");
  });

  it("output ends with a clear instruction (markdown only, no JSON)", () => {
    const input: SynthesisInput = {
      roomId: "x",
      room: ROOM,
      participants: { guard: RESOLVED },
      contributions: { guard: { raw_md: "x" } },
      throughSequence: 1,
    };
    const prompt = buildSynthesisPrompt(input);
    expect(prompt).toMatch(/Output markdown only — no JSON wrapper/);
  });
});
