import { describe, it, expect } from "vitest";

import {
  anyPluginEnabled,
  buildPluginsPayload,
  githubHasWatch,
  hydratePluginsState,
  parseAuthorList,
  type FormValidationInput,
  type PluginsFormState,
  validateForm,
} from "./form-logic";
import { defaultPlugins } from "./types";

function baseState(overrides: Partial<PluginsFormState> = {}): PluginsFormState {
  return { ...defaultPlugins(), ...overrides };
}

function validInput(overrides: Partial<FormValidationInput> = {}): FormValidationInput {
  return {
    isEdit: false,
    name: "reviewer",
    displayName: "",
    engine: "claude",
    agentTokenName: "tok",
    systemPrompt: "",
    plugins: baseState({ tasks: { enabled: true } }),
    ...overrides,
  };
}

describe("parseAuthorList", () => {
  it("splits on commas and whitespace and dedupes", () => {
    expect(parseAuthorList("alice, bob  alice\ncarol")).toEqual(["alice", "bob", "carol"]);
  });
  it("returns [] for blank input", () => {
    expect(parseAuthorList("   ,  ")).toEqual([]);
  });
});

describe("anyPluginEnabled / githubHasWatch", () => {
  it("anyPluginEnabled false when all off, true when one on", () => {
    expect(anyPluginEnabled(baseState())).toBe(false);
    expect(anyPluginEnabled(baseState({ tasks: { enabled: true } }))).toBe(true);
  });
  it("githubHasWatch reflects the three watch flags", () => {
    const g = defaultPlugins().github;
    expect(
      githubHasWatch({
        ...g,
        watch_new_prs: false,
        watch_review_requests: false,
        watch_mentions: false,
      }),
    ).toBe(false);
    expect(
      githubHasWatch({
        ...g,
        watch_new_prs: false,
        watch_review_requests: false,
        watch_mentions: true,
      }),
    ).toBe(true);
  });
});

describe("validateForm", () => {
  it("passes for a valid create", () => {
    expect(validateForm(validInput())).toBeNull();
  });

  it("rejects an invalid name on create", () => {
    expect(validateForm(validInput({ name: "Bad Name" }))).toMatch(/lowercase identifier/);
  });

  it("does not validate name on edit (immutable)", () => {
    expect(validateForm(validInput({ isEdit: true, name: "" }))).toBeNull();
  });

  it("requires a token", () => {
    expect(validateForm(validInput({ agentTokenName: "" }))).toMatch(/Pick a token/);
  });

  it("requires an engine", () => {
    expect(validateForm(validInput({ engine: "" }))).toMatch(/Pick an engine/);
  });

  it("requires at least one plugin enabled", () => {
    const input = validInput({ plugins: baseState() });
    expect(validateForm(input)).toMatch(/at least one plugin/i);
  });

  it("requires at least one github watch when github is enabled", () => {
    const plugins = baseState({
      github: {
        ...defaultPlugins().github,
        enabled: true,
        repos: ["o/r"],
        watch_new_prs: false,
        watch_review_requests: false,
        watch_mentions: false,
      },
    });
    expect(validateForm(validInput({ plugins }))).toMatch(/at least one GitHub watch/i);
  });

  it("requires at least one repo when github is enabled", () => {
    const plugins = baseState({
      github: { ...defaultPlugins().github, enabled: true, repos: [] },
    });
    expect(validateForm(validInput({ plugins }))).toMatch(/at least one repository/i);
  });

  it("requires a schedule prompt when schedule is enabled", () => {
    const plugins = baseState({
      schedule: { ...defaultPlugins().schedule, enabled: true, prompt: "  " },
    });
    expect(validateForm(validInput({ plugins }))).toMatch(/schedule prompt is required/i);
  });

  it("rejects an invalid github PR-author login", () => {
    const plugins = baseState({
      github: {
        ...defaultPlugins().github,
        enabled: true,
        repos: ["o/r"],
        watch_new_prs: true,
        watch_new_prs_authors: ["bad login!"],
      },
    });
    expect(validateForm(validInput({ plugins }))).toMatch(/not a valid GitHub login/i);
  });

  it("does NOT block on a capability gap (soft warning only)", () => {
    // validateForm never considers token capabilities, so a tasks-enabled agent
    // must still validate regardless of whether the token can claim tasks.
    const input = validInput({ plugins: baseState({ tasks: { enabled: true } }) });
    expect(validateForm(input)).toBeNull();
  });
});

describe("buildPluginsPayload — canonical shape", () => {
  it("emits every plugin block with only stored fields", () => {
    const state = baseState({
      github: {
        ...defaultPlugins().github,
        enabled: true,
        repos: ["owner/repo"],
        watch_new_prs: true,
      },
      schedule: { ...defaultPlugins().schedule, enabled: true, prompt: "do work" },
      tasks: { enabled: true },
      war_rooms: { enabled: true, contribute: true },
    });
    const payload = buildPluginsPayload(state);

    expect(Object.keys(payload).sort()).toEqual(["github", "schedule", "tasks", "war_rooms"]);
    // github carries repos here — the ONLY place repos live.
    expect(payload.github).toMatchObject({
      enabled: true,
      repos: ["owner/repo"],
      watch_new_prs: true,
      watch_review_requests: true,
      watch_mentions: false,
      poll_interval_secs: 300,
    });
    expect(payload.schedule).toEqual({
      enabled: true,
      interval_secs: 21600,
      jitter_secs: 600,
      prompt: "do work",
    });
    expect(payload.tasks).toEqual({ enabled: true });
    expect(payload.war_rooms).toEqual({ enabled: true, contribute: true });
  });

  it("omits watch_new_prs_authors when empty (empty = all authors)", () => {
    const state = baseState({
      github: {
        ...defaultPlugins().github,
        enabled: true,
        repos: ["o/r"],
        watch_new_prs_authors: [],
      },
    });
    expect(buildPluginsPayload(state).github).not.toHaveProperty("watch_new_prs_authors");
  });

  it("carries watch_new_prs_authors when non-empty", () => {
    const state = baseState({
      github: {
        ...defaultPlugins().github,
        enabled: true,
        repos: ["o/r"],
        watch_new_prs_authors: ["alice"],
      },
    });
    expect(buildPluginsPayload(state).github?.watch_new_prs_authors).toEqual(["alice"]);
  });

  it("has NO top-level repos / duty / triggers fields anywhere", () => {
    const payload = buildPluginsPayload(baseState({ tasks: { enabled: true } })) as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("repos");
    expect(payload).not.toHaveProperty("duty");
    expect(payload).not.toHaveProperty("triggers");
    // repos must only ever appear under github.
    expect(payload.github).toHaveProperty("repos");
  });
});

describe("hydratePluginsState", () => {
  it("returns defaults when the agent has no stored plugins", () => {
    expect(hydratePluginsState(defaultPlugins(), undefined)).toEqual(defaultPlugins());
  });

  it("merges a partial stored plugin set over defaults", () => {
    const hydrated = hydratePluginsState(defaultPlugins(), {
      github: {
        enabled: true,
        repos: ["o/r"],
        watch_new_prs: true,
        watch_review_requests: false,
        watch_mentions: false,
        poll_interval_secs: 120,
      },
    });
    expect(hydrated.github.enabled).toBe(true);
    expect(hydrated.github.repos).toEqual(["o/r"]);
    expect(hydrated.github.poll_interval_secs).toBe(120);
    // Absent plugins fall back to defaults (disabled).
    expect(hydrated.tasks.enabled).toBe(false);
    expect(hydrated.war_rooms).toEqual(defaultPlugins().war_rooms);
    // Missing authors key becomes [] for the form.
    expect(hydrated.github.watch_new_prs_authors).toEqual([]);
  });
});
