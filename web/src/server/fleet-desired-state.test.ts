import { describe, it, expect } from "vitest";
import { buildDesiredState, DESIRED_STATE_CONTRACT_VERSION, rosterEtag } from "@/server/fleet-desired-state";
import type { FleetAgent } from "@/server/fleet-store";

function agent(over: Partial<FleetAgent> = {}): FleetAgent {
  return {
    name: "builder",
    repos: ["hivemoot/hivemoot"],
    engine: "claude",
    skills: ["code-reviewer"],
    system_prompt: "Be helpful.",
    triggers: {
      schedule: { enabled: true, settings: { interval_secs: 21600, jitter_secs: 600, prompt: "Make progress." } },
      pull_requests: { enabled: false, settings: { watch_new_prs: true, watch_review_requests: true, author_allowlist: [], poll_interval_secs: 300 } },
      mentions: { enabled: false, settings: { poll_interval_secs: 90 } },
      tasks: { enabled: false, settings: {} },
      war_rooms: { enabled: false, settings: { contribute: false } },
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

  it("LISTS disabled agents (so the sidecar stops them)", () => {
    const ds = buildDesiredState({ agents: [agent({ enabled: false })], rosterVersion: 1, generatedAt });
    expect(ds.agents).toHaveLength(1);
    expect(ds.agents[0].enabled).toBe(false);
  });

  it("EXCLUDES unmanaged (observe-only) agents", () => {
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
    expect(a.repos).toEqual(["hivemoot/hivemoot"]);
    expect(a.skills).toEqual(["code-reviewer"]);
    expect(a.system_prompt).toBe("Be helpful.");
    expect(a.config_version).toBe(3);
    expect(a.triggers.schedule.enabled).toBe(true);
  });
});
