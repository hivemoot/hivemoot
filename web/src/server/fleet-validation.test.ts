import { describe, it, expect } from "vitest";
import {
  validateCreateAgentInput,
  validateUpdateAgentInput,
  validateRepo,
  validateAgentName,
} from "@/server/fleet-store";

function baseTriggers(over: Record<string, unknown> = {}) {
  return {
    schedule: { enabled: false, settings: { interval_secs: 21600, jitter_secs: 600, prompt: "" } },
    pull_requests: {
      enabled: false,
      settings: { watch_new_prs: true, watch_review_requests: true, author_allowlist: [], poll_interval_secs: 300 },
    },
    mentions: { enabled: false, settings: { poll_interval_secs: 90 } },
    tasks: { enabled: false, settings: {} },
    war_rooms: { enabled: false, settings: { contribute: false } },
    ...over,
  };
}

function baseBody(over: Record<string, unknown> = {}) {
  return {
    name: "builder",
    repo: "hivemoot/hivemoot",
    engine: "claude",
    duty: "standing",
    skills: ["code-reviewer"],
    system_prompt: "Be helpful.",
    triggers: baseTriggers(),
    ...over,
  };
}

describe("validateAgentName", () => {
  it("accepts a valid identifier", () => {
    expect(validateAgentName("builder").ok).toBe(true);
  });
  it.each(["Builder", "1agent", "_x", "-x", "a".repeat(33), "", "has space"])(
    "rejects %s",
    (v) => {
      expect(validateAgentName(v).ok).toBe(false);
    },
  );
});

describe("validateRepo (injection / traversal)", () => {
  it("accepts owner/name", () => {
    expect(validateRepo("hivemoot/hivemoot").ok).toBe(true);
  });
  it.each([
    "../etc/passwd",
    "owner/../x",
    "owner",
    "owner/name/extra",
    "owner//name",
    "owner /name",
    "-owner/name",
    "owner/name;rm -rf",
    "owner/$(whoami)",
  ])("rejects %s", (v) => {
    expect(validateRepo(v).ok).toBe(false);
  });
});

describe("validateCreateAgentInput", () => {
  it("accepts a valid body and normalizes", () => {
    const r = validateCreateAgentInput(baseBody());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("builder");
      expect(r.value.skills).toEqual(["code-reviewer"]);
      expect(r.value.duty).toBe("standing");
    }
  });

  it("rejects unknown engine", () => {
    const r = validateCreateAgentInput(baseBody({ engine: "gpt-9000" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("engine");
  });

  it("rejects unknown / malformed skills (no path traversal)", () => {
    expect(validateCreateAgentInput(baseBody({ skills: ["../../etc"] })).ok).toBe(false);
    expect(validateCreateAgentInput(baseBody({ skills: ["totally-unknown-skill"] })).ok).toBe(false);
  });

  it("dedupes skills", () => {
    const r = validateCreateAgentInput(baseBody({ skills: ["code-reviewer", "code-reviewer", "pr-hygiene"] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.skills).toEqual(["code-reviewer", "pr-hygiene"]);
  });

  it("strips control characters from system_prompt", () => {
    const bel = String.fromCharCode(7); // BEL — a C0 control char
    const r = validateCreateAgentInput(baseBody({ system_prompt: `hi${bel}there` }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.system_prompt).toBe("hithere");
  });

  it("rejects an over-long system_prompt", () => {
    const r = validateCreateAgentInput(baseBody({ system_prompt: "x".repeat(40_000) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("system_prompt");
  });

  it("rejects the privileged queen trigger from the dashboard", () => {
    const r = validateCreateAgentInput(
      baseBody({ triggers: baseTriggers({ queen: { enabled: true, settings: {} } }) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("triggers.queen");
  });

  it("requires a prompt when schedule is enabled", () => {
    const r = validateCreateAgentInput(
      baseBody({ triggers: baseTriggers({ schedule: { enabled: true, settings: { interval_secs: 3600, jitter_secs: 60, prompt: "" } } }) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("triggers.schedule.prompt");
  });

  it("rejects pull_requests enabled with no watch flag", () => {
    const r = validateCreateAgentInput(
      baseBody({
        triggers: baseTriggers({
          pull_requests: { enabled: true, settings: { watch_new_prs: false, watch_review_requests: false, author_allowlist: [], poll_interval_secs: 300 } },
        }),
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an out-of-bounds schedule interval", () => {
    const r = validateCreateAgentInput(
      baseBody({ triggers: baseTriggers({ schedule: { enabled: true, settings: { interval_secs: 5, jitter_secs: 0, prompt: "go" } } }) }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid author allowlist login", () => {
    const r = validateCreateAgentInput(
      baseBody({
        triggers: baseTriggers({
          pull_requests: { enabled: true, settings: { watch_new_prs: true, watch_review_requests: false, author_allowlist: ["bad login!"], poll_interval_secs: 300 } },
        }),
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("validateUpdateAgentInput", () => {
  it("rejects attempts to change name or repo", () => {
    expect(validateUpdateAgentInput({ name: "other" }).ok).toBe(false);
    expect(validateUpdateAgentInput({ repo: "x/y" }).ok).toBe(false);
  });
  it("accepts a partial config patch", () => {
    const r = validateUpdateAgentInput({ engine: "codex", skills: ["pr-hygiene"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.engine).toBe("codex");
      expect(r.value.skills).toEqual(["pr-hygiene"]);
    }
  });
});
