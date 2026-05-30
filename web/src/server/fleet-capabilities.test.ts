import { describe, it, expect } from "vitest";
import {
  deriveCapabilities,
  KNOWN_CAPABILITIES,
  ADMIN_CLASS_CAPABILITIES,
  type DerivableTriggerFlags,
} from "@/server/agent-token-capabilities";

const KNOWN = new Set<string>(KNOWN_CAPABILITIES);
const FORBIDDEN = new Set<string>(["installation_token.mint", "pull_requests.merge", "agent_tokens.manage", "*"]);

function* allTriggerCombos(): Generator<DerivableTriggerFlags> {
  const keys: (keyof DerivableTriggerFlags)[] = ["schedule", "pull_requests", "mentions", "tasks", "war_rooms"];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const flags = {} as DerivableTriggerFlags;
    keys.forEach((k, i) => {
      flags[k] = Boolean(mask & (1 << i));
    });
    yield flags;
  }
}

describe("deriveCapabilities (closed allowlist)", () => {
  it("always grants agent_health.report and nothing for no triggers", () => {
    expect(deriveCapabilities({ schedule: false, pull_requests: false, mentions: false, tasks: false, war_rooms: false })).toEqual([
      "agent_health.report",
    ]);
  });

  it("grants the task lifecycle for the tasks trigger", () => {
    const caps = deriveCapabilities({ schedule: false, pull_requests: false, mentions: false, tasks: true, war_rooms: false });
    expect(caps).toEqual(["agent_health.report", "tasks.claim", "tasks.complete", "tasks.progress"]);
  });

  it("grants OBSERVE-ONLY room access for war_rooms without contribute", () => {
    const caps = deriveCapabilities({ schedule: false, pull_requests: false, mentions: false, tasks: false, war_rooms: true });
    // Exact set — observe-only never includes rooms.contribute (no posting) and
    // never any extra/admin capability sneaking into the war_rooms branch.
    expect(caps).toEqual(["agent_health.report", "rooms.read", "rooms.watch"]);
  });

  it("grants rooms.contribute only when war_rooms contribute is enabled", () => {
    const caps = deriveCapabilities({
      schedule: false,
      pull_requests: false,
      mentions: false,
      tasks: false,
      war_rooms: true,
      war_rooms_contribute: true,
    });
    expect(caps).toContain("rooms.contribute");
    expect(caps).not.toContain("rooms.create");
  });

  it("github-watch triggers add no extra hivemoot capability", () => {
    const caps = deriveCapabilities({ schedule: true, pull_requests: true, mentions: true, tasks: false, war_rooms: false });
    expect(caps).toEqual(["agent_health.report"]);
  });

  it("NEVER emits an admin / mint / merge / wildcard capability for ANY trigger combination", () => {
    for (const flags of allTriggerCombos()) {
      const caps = deriveCapabilities(flags);
      for (const c of caps) {
        expect(c.includes("*")).toBe(false);
        expect(FORBIDDEN.has(c)).toBe(false);
        expect(ADMIN_CLASS_CAPABILITIES.has(c)).toBe(false);
        // subset of the known vocabulary
        expect(KNOWN.has(c)).toBe(true);
      }
    }
  });
});
