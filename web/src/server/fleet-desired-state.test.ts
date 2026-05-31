import { describe, it, expect } from "vitest";
import { buildDesiredState, DESIRED_STATE_CONTRACT_VERSION, rosterEtag } from "@/server/fleet-desired-state";
import type { FleetAgent } from "@/server/fleet-store";

function agent(over: Partial<FleetAgent> = {}): FleetAgent {
  return {
    name: "builder",
    engine: "claude",
    skills: ["code-reviewer"],
    system_prompt: "Be helpful.",
    plugins: {
      github: {
        enabled: true,
        repos: ["hivemoot/hivemoot"],
        watch_new_prs: true,
        watch_review_requests: true,
        watch_mentions: false,
        poll_interval_secs: 90,
      },
      schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "Make progress." },
    },
    enabled: true,
    managed: true,
    agent_token_name: "builder",
    created_at: "2026-05-29T00:00:00.000Z",
    created_by: "dk",
    updated_at: "2026-05-29T00:00:00.000Z",
    config_version: 3,
    ...over,
  };
}

describe("buildDesiredState (wire contract)", () => {
  const generatedAt = "2026-05-29T12:00:00.000Z";

  it("resolves the engine descriptor fully", () => {
    const ds = buildDesiredState({ agents: [agent()], rosterVersion: 5, generatedAt });
    expect(ds.version).toBe(DESIRED_STATE_CONTRACT_VERSION);
    // ETag folds in contract + engine-catalog version so deploys bust caches.
    expect(ds.etag).toBe(rosterEtag(5));
    expect(ds.etag).toMatch(/^roster-v5-c\d+-e[0-9a-f]{8}$/);
    expect(ds.agents[0].engine).toEqual({ id: "claude", tool: "claude", provider: null, model: null, tool_options: null });
  });

  it("ships the canonical `plugins` shape (no top-level repos/triggers)", () => {
    const ds = buildDesiredState({ agents: [agent()], rosterVersion: 1, generatedAt });
    const a = ds.agents[0] as unknown as Record<string, unknown>;
    expect(a.plugins).toBeDefined();
    expect(a.repos).toBeUndefined();
    expect(a.triggers).toBeUndefined();
    expect(ds.agents[0].plugins.github?.repos).toEqual(["hivemoot/hivemoot"]);
    expect(ds.agents[0].plugins.schedule?.enabled).toBe(true);
  });

  it("LISTS disabled agents (so the sidecar stops them)", () => {
    const ds = buildDesiredState({ agents: [agent({ enabled: false })], rosterVersion: 1, generatedAt });
    expect(ds.agents).toHaveLength(1);
    expect(ds.agents[0].enabled).toBe(false);
  });

  it("EXCLUDES unmanaged (observe-only) agents (deleted/foreign are simply absent)", () => {
    const ds = buildDesiredState({ agents: [agent({ managed: false })], rosterVersion: 1, generatedAt });
    expect(ds.agents).toHaveLength(0);
  });

  it("exposes only the token NAME — never a bearer value or any secret", () => {
    const ds = buildDesiredState({ agents: [agent()], rosterVersion: 1, generatedAt });
    expect(ds.agents[0].token).toEqual({ name: "builder", agent_role: "builder" });
    const serialized = JSON.stringify(ds).toLowerCase();
    // No secret-shaped fields leak into the contract.
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("hmt_");
    expect(serialized).not.toContain("private");
  });

  it("carries the full resolved config a sidecar needs to render a container", () => {
    const ds = buildDesiredState({ agents: [agent()], rosterVersion: 1, generatedAt });
    const a = ds.agents[0];
    expect(a.plugins.github?.repos).toEqual(["hivemoot/hivemoot"]);
    expect(a.skills).toEqual(["code-reviewer"]);
    expect(a.system_prompt).toBe("Be helpful.");
    expect(a.config_version).toBe(3);
    expect(a.plugins.schedule?.enabled).toBe(true);
  });

  it("OMITS disabled plugin blocks from the projection (ships only enabled ones)", () => {
    // The registry stores disabled blocks for round-trip editing, but a disabled
    // block carries no operational info — the reconciler only acts on enabled
    // plugins. Omitting it is equivalent to apiarist's optional/absent-plugin
    // handling (a future apiarist that validated a present block unconditionally
    // must not fail-close on a block that means nothing).
    const mixed = agent({
      plugins: {
        github: {
          enabled: false,
          repos: [],
          watch_new_prs: false,
          watch_review_requests: false,
          watch_mentions: false,
          poll_interval_secs: 300,
        },
        schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "Make progress." },
      },
    });
    const ds = buildDesiredState({ agents: [mixed], rosterVersion: 1, generatedAt });
    const plugins = ds.agents[0].plugins;
    expect(plugins.github).toBeUndefined();
    expect(plugins.schedule?.enabled).toBe(true);
    // And it doesn't leak over the wire either.
    const serialized = JSON.parse(JSON.stringify(ds)) as typeof ds;
    expect(serialized.agents[0].plugins.github).toBeUndefined();
    expect(serialized.agents[0].plugins.schedule?.enabled).toBe(true);
    // The disabled key is absent entirely (not present-but-undefined-ish).
    expect(Object.keys(serialized.agents[0].plugins)).toEqual(["schedule"]);
  });

  it("preserves a non-empty watch_new_prs_authors allowlist into the wire contract", () => {
    // The author filter is security-relevant: it scopes which PRs the agent will
    // react to. It must survive buildDesiredState into the reconciler's payload.
    const withAuthors = agent({
      plugins: {
        github: {
          enabled: true,
          repos: ["hivemoot/hivemoot"],
          watch_new_prs: true,
          watch_review_requests: false,
          watch_mentions: false,
          watch_new_prs_authors: ["dependabot", "renovate"],
          poll_interval_secs: 90,
        },
      },
    });
    const ds = buildDesiredState({ agents: [withAuthors], rosterVersion: 1, generatedAt });
    expect(ds.agents[0].plugins.github?.watch_new_prs_authors).toEqual(["dependabot", "renovate"]);
    // And it round-trips through serialization (what actually goes over the wire).
    const reserialized = JSON.parse(JSON.stringify(ds)) as typeof ds;
    expect(reserialized.agents[0].plugins.github?.watch_new_prs_authors).toEqual(["dependabot", "renovate"]);
  });
});
