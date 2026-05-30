import { describe, it, expect } from "vitest";
import {
  validateCreateAgentInput,
  validateUpdateAgentInput,
  validatePlugins,
  validateRepo,
  validateAgentName,
  type FleetPlugins,
} from "@/server/fleet-store";

// A minimal "does something" plugin set: schedule enabled (no repos/coverage
// needed) so the "≥1 plugin enabled" rule is satisfied by default.
function basePlugins(over: Partial<FleetPlugins> = {}): Record<string, unknown> {
  return {
    schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "Make progress." },
    ...over,
  } as Record<string, unknown>;
}

function githubPlugin(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    repos: ["owner/repo"],
    watch_new_prs: true,
    watch_review_requests: false,
    watch_mentions: false,
    poll_interval_secs: 90,
    ...over,
  };
}

function baseBody(over: Record<string, unknown> = {}) {
  return {
    name: "builder",
    engine: "claude",
    skills: ["code-reviewer"],
    system_prompt: "Be helpful.",
    plugins: basePlugins(),
    agent_token_name: "builder-token",
    ...over,
  };
}

describe("validateAgentName", () => {
  it("accepts a valid identifier", () => {
    expect(validateAgentName("builder").ok).toBe(true);
  });
  it.each(["Builder", "1agent", "_x", "-x", "a".repeat(33), "", "has space"])("rejects %s", (v) => {
    expect(validateAgentName(v).ok).toBe(false);
  });
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

describe("validatePlugins — at least one enabled", () => {
  it("rejects an empty plugins object (an agent that does nothing)", () => {
    const r = validatePlugins({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins");
  });

  it("rejects when every present plugin is disabled", () => {
    const r = validatePlugins({
      schedule: { enabled: false, interval_secs: 21600, jitter_secs: 600, prompt: "" },
      tasks: { enabled: false },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins");
  });

  it("rejects a non-object plugins value", () => {
    expect(validatePlugins(null).ok).toBe(false);
    expect(validatePlugins("nope").ok).toBe(false);
    expect(validatePlugins([]).ok).toBe(false);
  });

  it("accepts when at least one plugin is enabled (tasks-only)", () => {
    const r = validatePlugins({ tasks: { enabled: true } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tasks).toEqual({ enabled: true });
      // Omitted plugins stay omitted.
      expect(r.value.github).toBeUndefined();
      expect(r.value.schedule).toBeUndefined();
    }
  });

  it("rejects the privileged queen surface from the dashboard", () => {
    const r = validatePlugins({ ...basePlugins(), queen: { enabled: true } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.queen");
  });
});

describe("validatePlugins — github plugin", () => {
  it("accepts an enabled github plugin with repos + a watch flag", () => {
    const r = validatePlugins({ github: githubPlugin() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.github?.enabled).toBe(true);
      expect(r.value.github?.repos).toEqual(["owner/repo"]);
      expect(r.value.github?.poll_interval_secs).toBe(90);
    }
  });

  it("ACCEPTS an enabled github plugin with NO repos (the route resolver fills empty→all installed)", () => {
    const r = validatePlugins({ github: githubPlugin({ repos: [] }) });
    expect(r.ok).toBe(true);
    // The empty list is preserved here; resolveGithubRepos expands it at the route.
    if (r.ok) expect(r.value.github?.repos).toEqual([]);
  });

  it("rejects an enabled github plugin with a malformed repo (per-entry format still enforced)", () => {
    const r = validatePlugins({ github: githubPlugin({ repos: ["../etc"] }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.github.repos");
  });

  it("rejects an enabled github plugin with NO watch flag set", () => {
    const r = validatePlugins({
      github: githubPlugin({ watch_new_prs: false, watch_review_requests: false, watch_mentions: false }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.github");
  });

  it("accepts any single watch flag (mentions only)", () => {
    const r = validatePlugins({
      github: githubPlugin({ watch_new_prs: false, watch_review_requests: false, watch_mentions: true }),
    });
    expect(r.ok).toBe(true);
  });

  it("clamps/rejects an out-of-range poll_interval_secs", () => {
    expect(validatePlugins({ github: githubPlugin({ poll_interval_secs: 5 }) }).ok).toBe(false);
    expect(validatePlugins({ github: githubPlugin({ poll_interval_secs: 99999 }) }).ok).toBe(false);
    const ok = validatePlugins({ github: githubPlugin({ poll_interval_secs: 120 }) });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.github?.poll_interval_secs).toBe(120);
  });

  it("defaults poll_interval_secs to 300 when omitted (never NaN/undefined)", () => {
    const r = validatePlugins({ github: githubPlugin({ poll_interval_secs: undefined }) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.github?.poll_interval_secs).toBe(300);
      expect(Number.isInteger(r.value.github?.poll_interval_secs)).toBe(true);
    }
  });

  it("rejects a non-boolean watch flag whenever the block is present (even disabled)", () => {
    const bad = validatePlugins({
      // disabled, but a malformed watch flag must still be rejected (Stage-2 fail-closed parser).
      schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "go" },
      github: { enabled: false, repos: [], watch_new_prs: "yes", watch_review_requests: false, watch_mentions: false, poll_interval_secs: 90 },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("plugins.github.watch_new_prs");
  });

  it("rejects a malformed repos type whenever the block is present (even disabled)", () => {
    const bad = validatePlugins({
      schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "go" },
      github: { enabled: false, repos: "owner/repo", watch_new_prs: false, watch_review_requests: false, watch_mentions: false, poll_interval_secs: 90 },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("plugins.github.repos");
  });

  it("rejects a malformed poll_interval_secs (non-int) whenever the block is present (even disabled)", () => {
    const bad = validatePlugins({
      schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "go" },
      github: { enabled: false, repos: [], watch_new_prs: false, watch_review_requests: false, watch_mentions: false, poll_interval_secs: "fast" },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("plugins.github.poll_interval_secs");
  });

  it("dedupes repos", () => {
    const r = validatePlugins({ github: githubPlugin({ repos: ["owner/a", "owner/a", "owner/b"] }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.github?.repos).toEqual(["owner/a", "owner/b"]);
  });

  it("validates + dedupes watch_new_prs_authors, omitting the key when empty", () => {
    const ok = validatePlugins({ github: githubPlugin({ watch_new_prs_authors: ["alice", "alice", "bob"] }) });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.github?.watch_new_prs_authors).toEqual(["alice", "bob"]);

    const empty = validatePlugins({ github: githubPlugin({ watch_new_prs_authors: [] }) });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value.github?.watch_new_prs_authors).toBeUndefined();

    const bad = validatePlugins({ github: githubPlugin({ watch_new_prs_authors: ["bad login!"] }) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("plugins.github.watch_new_prs_authors");
  });

  it("allows a DISABLED github plugin with no repos (no enabled-only requirement when off) but still type-checks", () => {
    const r = validatePlugins({
      schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "go" },
      github: { enabled: false, repos: [], watch_new_prs: false, watch_review_requests: false, watch_mentions: false, poll_interval_secs: 90 },
    });
    expect(r.ok).toBe(true);
  });
});

describe("validatePlugins — schedule plugin", () => {
  it("requires a non-empty prompt when enabled", () => {
    const r = validatePlugins({ schedule: { enabled: true, interval_secs: 3600, jitter_secs: 60, prompt: "" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.schedule.prompt");
  });

  it("rejects a whitespace-only prompt when enabled (trim before checking)", () => {
    const r = validatePlugins({ schedule: { enabled: true, interval_secs: 3600, jitter_secs: 60, prompt: "   \n\t  " } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.schedule.prompt");
  });

  it("rejects a non-string prompt when present (no silent coercion)", () => {
    const r = validatePlugins({ schedule: { enabled: false, interval_secs: 3600, jitter_secs: 60, prompt: 42 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.schedule.prompt");
  });

  it("type-checks interval/jitter even when disabled (malformed-but-off still rejected)", () => {
    const r = validatePlugins({
      tasks: { enabled: true },
      schedule: { enabled: false, interval_secs: "soon", jitter_secs: 60, prompt: "" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.schedule.interval_secs");
  });

  it("rejects an out-of-bounds interval", () => {
    expect(validatePlugins({ schedule: { enabled: true, interval_secs: 5, jitter_secs: 0, prompt: "go" } }).ok).toBe(false);
    expect(validatePlugins({ schedule: { enabled: true, interval_secs: 99_999_999, jitter_secs: 0, prompt: "go" } }).ok).toBe(false);
  });

  it("rejects jitter greater than interval", () => {
    const r = validatePlugins({ schedule: { enabled: true, interval_secs: 300, jitter_secs: 3600, prompt: "go" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.schedule.jitter_secs");
  });

  it("rejects an out-of-bounds jitter", () => {
    const r = validatePlugins({ schedule: { enabled: true, interval_secs: 604800, jitter_secs: 99999, prompt: "go" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.schedule.jitter_secs");
  });
});

describe("validatePlugins — war_rooms plugin", () => {
  it("rejects a non-boolean contribute when present", () => {
    const r = validatePlugins({ war_rooms: { enabled: true, contribute: "yes" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.war_rooms.contribute");
  });

  it("requires contribute (no silent undefined) when the block is present, even disabled", () => {
    const r = validatePlugins({ tasks: { enabled: true }, war_rooms: { enabled: false } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.war_rooms.contribute");
  });

  it("accepts enabled war_rooms with contribute true/false", () => {
    expect(validatePlugins({ war_rooms: { enabled: true, contribute: true } }).ok).toBe(true);
    expect(validatePlugins({ war_rooms: { enabled: true, contribute: false } }).ok).toBe(true);
  });
});

describe("validateCreateAgentInput", () => {
  it("accepts a valid body and normalizes", () => {
    const r = validateCreateAgentInput(baseBody());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("builder");
      expect(r.value.skills).toEqual(["code-reviewer"]);
      expect(r.value.agent_token_name).toBe("builder-token");
      expect(r.value.plugins.schedule?.enabled).toBe(true);
    }
  });

  it("rejects unknown engine", () => {
    const r = validateCreateAgentInput(baseBody({ engine: "gpt-9000" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("engine");
  });

  it("requires a valid agent_token_name (the linked token)", () => {
    expect(validateCreateAgentInput(baseBody({ agent_token_name: undefined })).ok).toBe(false);
    const bad = validateCreateAgentInput(baseBody({ agent_token_name: "BAD NAME" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("agent_token_name");
  });

  it("rejects a body with no enabled plugin", () => {
    const r = validateCreateAgentInput(baseBody({ plugins: { tasks: { enabled: false } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins");
  });

  it("ACCEPTS a github-enabled body without repos (route resolver fills empty→all installed)", () => {
    const r = validateCreateAgentInput(baseBody({ plugins: { github: githubPlugin({ repos: [] }) } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.plugins.github?.repos).toEqual([]);
  });

  it("rejects a github-enabled body with no watch flag", () => {
    const r = validateCreateAgentInput(
      baseBody({
        plugins: { github: githubPlugin({ watch_new_prs: false, watch_review_requests: false, watch_mentions: false }) },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.github");
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

  it("rejects the privileged queen plugin from the dashboard", () => {
    const r = validateCreateAgentInput(baseBody({ plugins: { ...basePlugins(), queen: { enabled: true } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.queen");
  });

  it("requires a prompt when schedule is enabled", () => {
    const r = validateCreateAgentInput(
      baseBody({ plugins: { schedule: { enabled: true, interval_secs: 3600, jitter_secs: 60, prompt: "" } } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("plugins.schedule.prompt");
  });
});

describe("validateUpdateAgentInput", () => {
  it("rejects attempts to change name or the removed top-level fields", () => {
    expect(validateUpdateAgentInput({ name: "other" }).ok).toBe(false);
    expect(validateUpdateAgentInput({ repo: "x/y" }).ok).toBe(false);
    expect(validateUpdateAgentInput({ repos: ["x/y"] }).ok).toBe(false);
    expect(validateUpdateAgentInput({ triggers: {} }).ok).toBe(false);
    expect(validateUpdateAgentInput({ duty: "standing" }).ok).toBe(false);
  });

  it("accepts a partial config patch (engine + skills)", () => {
    const r = validateUpdateAgentInput({ engine: "codex", skills: ["pr-hygiene"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.engine).toBe("codex");
      expect(r.value.skills).toEqual(["pr-hygiene"]);
    }
  });

  it("accepts a plugins patch and validates it", () => {
    const ok = validateUpdateAgentInput({ plugins: { tasks: { enabled: true } } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.plugins?.tasks?.enabled).toBe(true);

    const bad = validateUpdateAgentInput({ plugins: { tasks: { enabled: false } } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("plugins");
  });

  it("PATCH parity: a plugins patch enforces the SAME per-plugin rules as create", () => {
    // github with a malformed repo → same per-entry rejection create gives.
    // (Empty-repos-when-enabled is NOT a validation error anymore — the route
    // resolver fills empty→all installed — so we assert format enforcement here.)
    const badRepo = validateUpdateAgentInput({
      plugins: { github: { enabled: true, repos: ["../etc"], watch_new_prs: true, watch_review_requests: false, watch_mentions: false, poll_interval_secs: 90 } },
    });
    expect(badRepo.ok).toBe(false);
    if (!badRepo.ok) expect(badRepo.field).toBe("plugins.github.repos");

    // an enabled github plugin with NO repos is ACCEPTED at validation (route resolves).
    const noRepos = validateUpdateAgentInput({
      plugins: { github: { enabled: true, repos: [], watch_new_prs: true, watch_review_requests: false, watch_mentions: false, poll_interval_secs: 90 } },
    });
    expect(noRepos.ok).toBe(true);

    // at-least-one-enabled also enforced on PATCH.
    const noneEnabled = validateUpdateAgentInput({ plugins: { schedule: { enabled: false, interval_secs: 21600, jitter_secs: 600, prompt: "" } } });
    expect(noneEnabled.ok).toBe(false);
    if (!noneEnabled.ok) expect(noneEnabled.field).toBe("plugins");

    // malformed-but-disabled type still rejected on PATCH.
    const badType = validateUpdateAgentInput({
      plugins: { tasks: { enabled: true }, war_rooms: { enabled: false } },
    });
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.field).toBe("plugins.war_rooms.contribute");
  });

  it("PATCH without a plugins key leaves plugins untouched (not required)", () => {
    const r = validateUpdateAgentInput({ engine: "codex" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.plugins).toBeUndefined();
  });
});
