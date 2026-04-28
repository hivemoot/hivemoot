import { describe, it, expect } from "vitest";
import {
  KNOWN_CAPABILITIES,
  ADMIN_CLASS_CAPABILITIES,
  PRESETS,
  CapabilityValidationError,
  expandCapabilities,
  bearerHasCapability,
  isKnownPreset,
  resolvePreset,
  validateName,
  validateAgentRole,
  validateCapabilityString,
  NAME_REGEX,
  CAPABILITY_REGEX,
} from "./agent-token-capabilities";

// ---------------------------------------------------------------------------
// Validation regexes
// ---------------------------------------------------------------------------

describe("NAME_REGEX", () => {
  it("accepts lowercase identifiers starting with a letter", () => {
    for (const name of ["worker", "drone", "a", "x_y", "x-y", "abc123", "a".repeat(32)]) {
      expect(NAME_REGEX.test(name), name).toBe(true);
    }
  });

  it("rejects uppercase, leading non-letter, empty, too-long, or invalid chars", () => {
    for (const name of [
      "Worker",       // uppercase
      "1worker",      // leading digit
      "_worker",      // leading underscore
      "-worker",      // leading hyphen
      "",             // empty
      "a".repeat(33), // > 32
      "a b",          // space
      "a/b",          // slash
      "a.b",          // dot
      "a@b",          // at
    ]) {
      expect(NAME_REGEX.test(name), name).toBe(false);
    }
  });
});

describe("CAPABILITY_REGEX", () => {
  it("accepts bare *, identifier, identifier.*, multi-segment", () => {
    for (const cap of [
      "*",
      "tasks.claim",
      "tasks.*",
      "agent_health.report",
      "installation_token.mint",
      "rooms.read",
      "single",            // single-segment identifier
    ]) {
      expect(CAPABILITY_REGEX.test(cap), cap).toBe(true);
    }
  });

  it("rejects uppercase, mid-segment wildcard, leading wildcard segment, empty segments", () => {
    for (const cap of [
      "Tasks.Claim",  // uppercase
      "tasks.",       // trailing dot
      "*.claim",      // leading wildcard segment
      "tasks.*claim", // mid-segment wildcard
      "tasks.cl*aim", // mid-segment wildcard
      "tasks.*.foo",  // wildcard NOT trailing
      "tasks..claim", // empty segment
      "",             // empty
      "tasks.claim ", // trailing space
      "tasks.cl-aim", // hyphen not allowed in segment per spec
    ]) {
      expect(CAPABILITY_REGEX.test(cap), cap).toBe(false);
    }
  });
});

describe("validateName", () => {
  it("returns silently on valid name", () => {
    expect(() => validateName("worker")).not.toThrow();
  });

  it("throws CapabilityValidationError naming the field on invalid name", () => {
    let captured: CapabilityValidationError | null = null;
    try {
      validateName("Worker");
    } catch (e) {
      captured = e as CapabilityValidationError;
    }
    expect(captured).toBeInstanceOf(CapabilityValidationError);
    expect(captured?.field).toBe("name");
    expect(captured?.value).toBe("Worker");
    expect(captured?.message).toContain("Worker");
  });
});

describe("validateAgentRole", () => {
  it("uses the same regex as name (operator can name a role with the same shape as a token name)", () => {
    expect(() => validateAgentRole("drone")).not.toThrow();
    expect(() => validateAgentRole("Drone")).toThrow(CapabilityValidationError);
  });

  it("error.field is agent_role (not name)", () => {
    let captured: CapabilityValidationError | null = null;
    try {
      validateAgentRole("");
    } catch (e) {
      captured = e as CapabilityValidationError;
    }
    expect(captured?.field).toBe("agent_role");
  });
});

describe("validateCapabilityString", () => {
  it("accepts canonical capabilities", () => {
    for (const c of KNOWN_CAPABILITIES) {
      expect(() => validateCapabilityString(c)).not.toThrow();
    }
  });

  it("accepts wildcards", () => {
    expect(() => validateCapabilityString("*")).not.toThrow();
    expect(() => validateCapabilityString("tasks.*")).not.toThrow();
  });

  it("rejects mid-segment wildcard (R2.1 fix)", () => {
    expect(() => validateCapabilityString("tasks.*claim")).toThrow(
      CapabilityValidationError,
    );
  });

  it("rejects uppercase and bad shapes", () => {
    expect(() => validateCapabilityString("Tasks.Claim")).toThrow();
    expect(() => validateCapabilityString("tasks.")).toThrow();
    expect(() => validateCapabilityString("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wildcard expansion
// ---------------------------------------------------------------------------

describe("expandCapabilities", () => {
  it("empty list → empty set", () => {
    expect(expandCapabilities([]).size).toBe(0);
  });

  it("concrete strings pass through", () => {
    const out = expandCapabilities(["tasks.claim", "rooms.read"]);
    expect(out.has("tasks.claim")).toBe(true);
    expect(out.has("rooms.read")).toBe(true);
    expect(out.size).toBe(2);
  });

  it("bare * expands to ALL KNOWN_CAPABILITIES except admin-class", () => {
    const out = expandCapabilities(["*"]);
    for (const k of KNOWN_CAPABILITIES) {
      if (ADMIN_CLASS_CAPABILITIES.has(k)) {
        expect(out.has(k), `* should NOT include admin-class ${k}`).toBe(false);
      } else {
        expect(out.has(k), `* should include ${k}`).toBe(true);
      }
    }
  });

  it("bare * does NOT include agent_tokens.manage (the canonical admin-class case)", () => {
    expect(expandCapabilities(["*"]).has("agent_tokens.manage")).toBe(false);
  });

  it("tasks.* expands only tasks.* entries (and excludes admin-class even if a task admin existed)", () => {
    const out = expandCapabilities(["tasks.*"]);
    expect(out.has("tasks.claim")).toBe(true);
    expect(out.has("tasks.progress")).toBe(true);
    expect(out.has("tasks.complete")).toBe(true);
    expect(out.has("tasks.create")).toBe(true);
    expect(out.has("tasks.read")).toBe(true);
    expect(out.has("tasks.cancel")).toBe(true);
    expect(out.has("tasks.verify")).toBe(true);
    // Should not bleed across subsystems
    expect(out.has("rooms.read")).toBe(false);
    expect(out.has("agent_health.report")).toBe(false);
    expect(out.has("installation_token.mint")).toBe(false);
    expect(out.has("agent_tokens.manage")).toBe(false);
  });

  it("agent_tokens.* does NOT expand to agent_tokens.manage (R2 N3 fix)", () => {
    // The whole point of ADMIN_CLASS_CAPABILITIES: an operator who
    // writes `agent_tokens.*` must NOT silently get the admin-class
    // capability. They must list it explicitly.
    const out = expandCapabilities(["agent_tokens.*"]);
    expect(out.has("agent_tokens.manage")).toBe(false);
    // Currently agent_tokens.manage is the only entry in
    // KNOWN_CAPABILITIES under that prefix, so the expansion is
    // empty. That's correct — the test pins the invariant for when
    // future agent_tokens.* entries arrive.
    expect(out.size).toBe(0);
  });

  it("explicit agent_tokens.manage works (admin-class IS reachable via single string)", () => {
    expect(
      expandCapabilities(["agent_tokens.manage"]).has("agent_tokens.manage"),
    ).toBe(true);
  });

  it("mixed wildcards + concretes deduplicate", () => {
    const out = expandCapabilities(["tasks.*", "tasks.claim", "rooms.read"]);
    // tasks.claim already expanded by tasks.*; concrete is dedup'd
    expect(out.has("tasks.claim")).toBe(true);
    expect(out.has("rooms.read")).toBe(true);
  });

  it("unknown concrete strings pass through as-is (the validator earlier in the lifecycle is what rejects them)", () => {
    const out = expandCapabilities(["tasks.imaginary"]);
    expect(out.has("tasks.imaginary")).toBe(true);
  });

  it("idempotent on the same input", () => {
    const a = expandCapabilities(["*", "tasks.claim"]);
    const b = expandCapabilities(["*", "tasks.claim"]);
    expect([...a].sort()).toEqual([...b].sort());
  });
});

describe("bearerHasCapability", () => {
  it("true when bearer literally holds the required cap", () => {
    expect(bearerHasCapability(["tasks.claim"], "tasks.claim")).toBe(true);
  });

  it("true when wildcard expansion covers the required cap", () => {
    expect(bearerHasCapability(["tasks.*"], "tasks.create")).toBe(true);
    expect(bearerHasCapability(["*"], "rooms.read")).toBe(true);
  });

  it("false when neither literal nor wildcard covers the required cap", () => {
    expect(bearerHasCapability(["tasks.claim"], "rooms.create")).toBe(false);
  });

  it("false on bare * for agent_tokens.manage (admin-class carve-out)", () => {
    expect(bearerHasCapability(["*"], "agent_tokens.manage")).toBe(false);
  });

  it("true when admin-class is listed explicitly alongside *", () => {
    expect(
      bearerHasCapability(["*", "agent_tokens.manage"], "agent_tokens.manage"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

describe("PRESETS", () => {
  it("every preset's capabilities pass CAPABILITY_REGEX validation", () => {
    for (const [presetName, caps] of Object.entries(PRESETS)) {
      for (const c of caps) {
        expect(
          () => validateCapabilityString(c),
          `${presetName}: ${c}`,
        ).not.toThrow();
      }
    }
  });

  it("worker preset does NOT include installation_token.mint (workers go through apiarist)", () => {
    expect(PRESETS.worker.includes("installation_token.mint")).toBe(false);
  });

  it("worker preset DOES include rooms.read (so triage can fetch room state)", () => {
    expect(PRESETS.worker.includes("rooms.read")).toBe(true);
  });

  it("queen preset has room-management caps", () => {
    expect(PRESETS.queen.includes("rooms.create")).toBe(true);
    expect(PRESETS.queen.includes("rooms.update")).toBe(true);
    expect(PRESETS.queen.includes("rooms.decide")).toBe(true);
    expect(PRESETS.queen.includes("rooms.close")).toBe(true);
  });

  it("apiarist preset is single-cap (smallest blast radius)", () => {
    expect(PRESETS.apiarist).toEqual(["installation_token.mint"]);
  });

  it("admin preset includes both bare * AND agent_tokens.manage explicit (wildcard alone wouldn't cover it)", () => {
    expect(PRESETS.admin.includes("*")).toBe(true);
    expect(PRESETS.admin.includes("agent_tokens.manage")).toBe(true);
  });

  it("admin preset's effective capability set covers EVERY KNOWN_CAPABILITIES entry", () => {
    const effective = expandCapabilities(PRESETS.admin);
    for (const k of KNOWN_CAPABILITIES) {
      expect(effective.has(k), `admin should grant ${k}`).toBe(true);
    }
  });
});

describe("isKnownPreset / resolvePreset", () => {
  it("returns true for each canonical preset name", () => {
    for (const name of Object.keys(PRESETS)) {
      expect(isKnownPreset(name)).toBe(true);
    }
  });

  it("returns false for unknown name", () => {
    expect(isKnownPreset("nonexistent")).toBe(false);
    expect(isKnownPreset("WORKER")).toBe(false); // case-sensitive
  });

  it("resolvePreset returns the cap list for known names", () => {
    expect(resolvePreset("apiarist")).toEqual(["installation_token.mint"]);
  });

  it("resolvePreset throws CapabilityValidationError on unknown name (no silent fallback)", () => {
    let captured: CapabilityValidationError | null = null;
    try {
      resolvePreset("nonexistent");
    } catch (e) {
      captured = e as CapabilityValidationError;
    }
    expect(captured).toBeInstanceOf(CapabilityValidationError);
    expect(captured?.field).toBe("preset");
    expect(captured?.value).toBe("nonexistent");
    // Error message lists valid presets so the operator gets immediate
    // feedback on typos.
    expect(captured?.message).toMatch(/apiarist|admin|worker/);
  });

  it("Object.prototype member name (e.g. 'toString') is NOT a valid preset", () => {
    // Prototype-pollution defense: hasOwnProperty (used by isKnownPreset)
    // must reject inherited member names like 'toString'.
    expect(isKnownPreset("toString")).toBe(false);
    expect(() => resolvePreset("toString")).toThrow(CapabilityValidationError);
  });
});

// ---------------------------------------------------------------------------
// Cross-invariants
// ---------------------------------------------------------------------------

describe("cross-invariants", () => {
  it("ADMIN_CLASS_CAPABILITIES is a subset of KNOWN_CAPABILITIES (no orphans)", () => {
    const known = new Set<string>(KNOWN_CAPABILITIES);
    for (const c of ADMIN_CLASS_CAPABILITIES) {
      expect(known.has(c), `admin-class cap ${c} must be in KNOWN_CAPABILITIES`).toBe(
        true,
      );
    }
  });

  it("KNOWN_CAPABILITIES has no duplicates", () => {
    const set = new Set<string>(KNOWN_CAPABILITIES);
    expect(set.size).toBe(KNOWN_CAPABILITIES.length);
  });

  it("every KNOWN_CAPABILITIES entry passes CAPABILITY_REGEX", () => {
    for (const c of KNOWN_CAPABILITIES) {
      expect(CAPABILITY_REGEX.test(c), c).toBe(true);
    }
  });

  it("KNOWN_CAPABILITIES count matches the design doc claim (20)", () => {
    // R2.2 baseline: 19 capabilities.
    // R3 (D.1.b-i): added `rooms.read_all` to differentiate
    // installation-wide listing (queen / monitoring) from worker
    // self-rooms reads (`rooms.read`). +1 → 20.
    // If this fails, the doc section "Total: N capabilities" needs
    // to be updated alongside the addition.
    expect(KNOWN_CAPABILITIES.length).toBe(20);
  });
});
