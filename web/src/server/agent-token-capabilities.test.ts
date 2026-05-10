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
  validateMintPolicyRequirement,
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

  it("rooms.synthesize is a known capability (RFC PR 3 + D14)", () => {
    expect(KNOWN_CAPABILITIES.includes("rooms.synthesize")).toBe(true);
  });

  it("rooms.synthesize is NOT in queen preset (no silent expansion — RFC builder pass-2 §2)", () => {
    expect(PRESETS.queen.includes("rooms.synthesize")).toBe(false);
    expect(PRESETS.queen.includes("installation_token.mint")).toBe(false);
  });

  it("local_queen preset has rooms.synthesize + installation_token.mint (RFC PR 3 + G16)", () => {
    expect(PRESETS.local_queen.includes("rooms.synthesize")).toBe(true);
    expect(PRESETS.local_queen.includes("installation_token.mint")).toBe(true);
  });

  it("local_queen preset does NOT include rooms.watch (RFC builder pass-7 §5: queen polls synthesis-ready, not /watching)", () => {
    expect(PRESETS.local_queen.includes("rooms.watch")).toBe(false);
  });

  it("local_queen preset has all queen-preset capabilities (additive only — D14)", () => {
    for (const cap of PRESETS.queen) {
      expect(
        PRESETS.local_queen.includes(cap),
        `local_queen should include queen's ${cap}`,
      ).toBe(true);
    }
  });

  it("local_queen does NOT include rooms.force_close (admin-only escape valve, G6)", () => {
    expect(PRESETS.local_queen.includes("rooms.force_close")).toBe(false);
  });

  it("every preset granting rooms.create also grants rooms.read_all (PR 645 guard G3, KNOWN_CAPABILITIES :149-157 invariant)", () => {
    // The KNOWN_CAPABILITIES note at agent-token-capabilities.ts:149-157
    // commits to this pairing: rooms.create's 409 subject_already_open
    // response surfaces existingRoomId, and that disclosure is benign
    // ONLY because the bearer also has rooms.read_all (so they can
    // already enumerate rooms anyway). A future preset with rooms.create
    // but WITHOUT rooms.read_all would turn the 409 into a roomId-
    // discovery oracle. Guard pass-1 on PR 645 asked for an automated
    // pin so this invariant doesn't regress silently.
    for (const [name, caps] of Object.entries(PRESETS)) {
      if (caps.includes("rooms.create")) {
        expect(
          caps.includes("rooms.read_all"),
          `${name} grants rooms.create but not rooms.read_all`,
        ).toBe(true);
      }
    }
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

  it("KNOWN_CAPABILITIES count matches the design doc claim (21)", () => {
    // R2.2 baseline: 19 capabilities.
    // R3 (D.1.b-i): added `rooms.read_all` to differentiate
    // installation-wide listing (queen / monitoring) from worker
    // self-rooms reads (`rooms.read`). +1 → 20.
    // RFC PR 3 (D14): added `rooms.synthesize` for the local-mode
    // queen synthesis-path endpoints. +1 → 21.
    // If this fails, the doc section "Total: N capabilities" needs
    // to be updated alongside the addition.
    expect(KNOWN_CAPABILITIES.length).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// Mint-capable issuance gate (PR 645 builder pass-1 B1)
// ---------------------------------------------------------------------------

describe("validateMintPolicyRequirement — RFC D10 + G16 + PR 645 builder pass-1+pass-2+pass-3", () => {
  // Canonical local_queen policy shape (both halves of D10).
  // Used as the happy-path baseline for every "policy passes" test.
  const D10_POLICY = {
    allowed_repos: ["hivemoot/colony"],
    allowed_permissions: {
      pull_requests: "write",
      issues: "write",
      metadata: "read",
    },
  };

  it("allows non-mint capabilities through with no policy", () => {
    const result = validateMintPolicyRequirement({
      capabilities: ["rooms.read", "tasks.claim"],
      presetName: "worker",
      policy: null,
    });
    expect(result.ok).toBe(true);
  });

  // ----- D10 half 1: allowed_repos -----

  it("rejects local_queen preset issued without a policy", () => {
    const result = validateMintPolicyRequirement({
      capabilities: PRESETS.local_queen,
      presetName: "local_queen",
      policy: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/policy\.allowedRepos/);
    }
  });

  it("rejects local_queen issued with policy whose allowed_repos is missing", () => {
    const result = validateMintPolicyRequirement({
      capabilities: PRESETS.local_queen,
      presetName: "local_queen",
      policy: { allowed_repos: null },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects local_queen issued with policy whose allowed_repos is empty array", () => {
    const result = validateMintPolicyRequirement({
      capabilities: PRESETS.local_queen,
      presetName: "local_queen",
      policy: { allowed_repos: [] },
    });
    expect(result.ok).toBe(false);
  });

  // ----- D10 half 2: allowed_permissions (builder pass-3) -----

  it("rejects local_queen with allowedRepos but NO allowedPermissions (pass-3 builder fix)", () => {
    // Pass-2 accepted this shape; pass-3 closes it because the mint
    // endpoint falls back to V1_PERMISSIONS (which includes
    // contents:read) when allowedPermissions is omitted, violating
    // RFC D10's permission scope half.
    const result = validateMintPolicyRequirement({
      capabilities: PRESETS.local_queen,
      presetName: "local_queen",
      policy: { allowed_repos: ["hivemoot/colony"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/allowedPermissions/);
      expect(result.message).toMatch(/contents/);
    }
  });

  it("rejects local_queen with allowedPermissions including 'contents' (any value)", () => {
    // RFC D10 explicitly drops `contents` — the local queen
    // synthesizes verdicts and posts comments; it must not read
    // repo files.
    for (const level of ["read", "write", "admin"]) {
      const result = validateMintPolicyRequirement({
        capabilities: PRESETS.local_queen,
        presetName: "local_queen",
        policy: {
          allowed_repos: ["hivemoot/colony"],
          allowed_permissions: {
            pull_requests: "write",
            issues: "write",
            metadata: "read",
            contents: level,
          },
        },
      });
      expect(result.ok, `contents=${level} should be rejected`).toBe(false);
    }
  });

  it("rejects local_queen with allowedPermissions narrower than D10 (e.g. read instead of write)", () => {
    // Narrower fails closed at mint time (intersect would clamp the
    // bearer to less than D10), but the gate's contract is "exact
    // match" so we surface the mismatch at issue time.
    const result = validateMintPolicyRequirement({
      capabilities: PRESETS.local_queen,
      presetName: "local_queen",
      policy: {
        allowed_repos: ["hivemoot/colony"],
        allowed_permissions: {
          pull_requests: "read", // should be "write"
          issues: "write",
          metadata: "read",
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects local_queen with EXTRA permission keys beyond D10", () => {
    const result = validateMintPolicyRequirement({
      capabilities: PRESETS.local_queen,
      presetName: "local_queen",
      policy: {
        allowed_repos: ["hivemoot/colony"],
        allowed_permissions: {
          pull_requests: "write",
          issues: "write",
          metadata: "read",
          actions: "read", // not in D10's set
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("allows local_queen with the EXACT D10 policy shape (allowedRepos + allowedPermissions)", () => {
    const result = validateMintPolicyRequirement({
      capabilities: PRESETS.local_queen,
      presetName: "local_queen",
      policy: D10_POLICY,
    });
    expect(result.ok).toBe(true);
  });

  // ----- Apiarist legacy carve-out -----

  it("apiarist preset is exempt from BOTH halves of the gate (legacy carve-out)", () => {
    // Apiarist predates the policy model. Both repo fan-out and
    // permission scope checks skip when presetName === 'apiarist'.
    const result = validateMintPolicyRequirement({
      capabilities: PRESETS.apiarist,
      presetName: "apiarist",
      policy: null,
    });
    expect(result.ok).toBe(true);
  });

  // ----- Label-laundering bypass (pass-2) -----

  it("explicit capabilities with role label 'apiarist' but presetName=null → rejected", () => {
    // The agentRole input field has been removed from
    // MintPolicyGateInput entirely — there's no way for the gate
    // to even see the operator-supplied role. Only presetName can
    // grant the apiarist exemption.
    const result = validateMintPolicyRequirement({
      capabilities: ["installation_token.mint"],
      presetName: null,
      policy: null,
    });
    expect(result.ok).toBe(false);
  });

  it("explicit capabilities with installation_token.mint but no preset → rejected", () => {
    const result = validateMintPolicyRequirement({
      capabilities: ["installation_token.mint", "rooms.synthesize"],
      presetName: null,
      policy: null,
    });
    expect(result.ok).toBe(false);
  });

  it("explicit-caps path can satisfy the gate by passing the full D10 policy explicitly", () => {
    // Operators who really want a non-preset mint-capable token
    // (e.g. custom roles) can still do so — they just have to
    // pass the canonical D10 policy. This test pins that the
    // gate is policy-based, not preset-required.
    const result = validateMintPolicyRequirement({
      capabilities: ["installation_token.mint", "rooms.synthesize"],
      presetName: null,
      policy: D10_POLICY,
    });
    expect(result.ok).toBe(true);
  });

  // ----- Wildcard-aware capability detection (pass-3 follow-up B1) -----
  // Pass-1 through pass-3 used `capabilities.includes("installation_token.mint")`
  // as a literal string check. The mint endpoint's auth uses
  // bearerHasCapability which expands wildcards. The asymmetry meant
  // `["installation_token.*"]` and `["*"]` slipped past the gate but
  // satisfied auth. Now both gates use the same expansion semantics.

  it("rejects capabilities ['installation_token.*'] without policy (wildcard expands to mint)", () => {
    // The literal includes() would say false; bearerHasCapability
    // expansion catches the wildcard form. Same auth predicate as
    // request-time, so no asymmetry.
    const result = validateMintPolicyRequirement({
      capabilities: ["installation_token.*"],
      presetName: null,
      policy: null,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects capabilities ['installation_token.*'] WITH allowedRepos but no allowedPermissions (D10 half 2 still required)", () => {
    const result = validateMintPolicyRequirement({
      capabilities: ["installation_token.*"],
      presetName: null,
      policy: { allowed_repos: ["hivemoot/colony"] },
    });
    expect(result.ok).toBe(false);
  });

  it("allows capabilities ['installation_token.*'] WITH full D10 policy (gate is policy-based, not literal-cap-based)", () => {
    const result = validateMintPolicyRequirement({
      capabilities: ["installation_token.*"],
      presetName: null,
      policy: D10_POLICY,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects capabilities ['*'] without allowWildcards opt-in (gate fires)", () => {
    // Bare * needs the explicit allowWildcards flag to qualify
    // for the admin chain-root carve-out. Without the flag,
    // the wildcard expansion still triggers the mint detection.
    const result = validateMintPolicyRequirement({
      capabilities: ["*"],
      presetName: null,
      policy: null,
    });
    expect(result.ok).toBe(false);
  });

  it("admin chain-root opt-in — capabilities ['*'] + allowWildcards: true → exempt (explicit power-user path)", () => {
    // The deliberate-opt-in admin path predates D10. Documented
    // carve-out keyed on the literal `*` cap + the operator's
    // explicit allowWildcards flag. Other wildcard forms (e.g.
    // `installation_token.*`) do NOT qualify even with the flag.
    const result = validateMintPolicyRequirement({
      capabilities: ["*"],
      presetName: null,
      allowWildcards: true,
      policy: null,
    });
    expect(result.ok).toBe(true);
  });

  it("admin preset name → exempt (mirrors capabilities-`*` opt-in via the preset path)", () => {
    const result = validateMintPolicyRequirement({
      capabilities: PRESETS.admin,
      presetName: "admin",
      policy: null,
    });
    expect(result.ok).toBe(true);
  });

  it("`installation_token.*` with allowWildcards: true is NOT the admin chain-root opt-in (gate still fires)", () => {
    // Only bare `*` qualifies for the admin opt-in. A scoped
    // wildcard prefix (`installation_token.*`) does NOT — that's
    // a narrower grant the operator can issue with proper D10
    // policy or not at all.
    const result = validateMintPolicyRequirement({
      capabilities: ["installation_token.*"],
      presetName: null,
      allowWildcards: true,
      policy: null,
    });
    expect(result.ok).toBe(false);
  });
});
