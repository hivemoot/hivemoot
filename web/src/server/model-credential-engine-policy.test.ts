/**
 * Unit tests for the engine → (provider, allowed-kinds) constraint map
 * (MODEL_AUTH_DESIGN.md §1.4). Pure-function tests; no Redis / I/O.
 */

import { describe, it, expect } from "vitest";
import {
  getEngineCredentialConstraint,
  validateCredentialForEngine,
} from "./model-credential-engine-policy";

describe("getEngineCredentialConstraint — engine → provider mapping", () => {
  // (engineId, expected provider) — derived from engine-catalog.ts tools.
  const cases: Array<[string, string]> = [
    ["claude", "anthropic"],
    ["claude-opus", "anthropic"],
    ["claude-opus-4-7", "anthropic"],
    ["claude-sonnet", "anthropic"],
    ["codex", "openai"],
    ["codex-spark", "openai"],
    ["codex-xhigh", "openai"],
    ["codex-gpt-5-5-xhigh", "openai"],
    ["kimi", "openrouter"],
    ["minimax", "openrouter"],
    ["zai", "zai"],
    ["gemini", "google"],
  ];

  for (const [engineId, provider] of cases) {
    it(`${engineId} → ${provider}`, () => {
      const c = getEngineCredentialConstraint(engineId);
      expect(c).not.toBeNull();
      expect(c?.provider).toBe(provider);
    });
  }

  it("returns null for an unknown engine (fail-closed)", () => {
    expect(getEngineCredentialConstraint("not-an-engine")).toBeNull();
  });

  it("codex allows ONLY oauth_subscription", () => {
    const c = getEngineCredentialConstraint("codex");
    expect(c?.allowedKinds).toEqual(["oauth_subscription"]);
  });

  it("claude allows oauth_subscription OR api_key", () => {
    const c = getEngineCredentialConstraint("claude");
    expect(c?.allowedKinds).toContain("oauth_subscription");
    expect(c?.allowedKinds).toContain("api_key");
  });

  it("openrouter / zai / google engines allow api_key", () => {
    expect(getEngineCredentialConstraint("kimi")?.allowedKinds).toEqual([
      "api_key",
    ]);
    expect(getEngineCredentialConstraint("zai")?.allowedKinds).toEqual([
      "api_key",
    ]);
    expect(getEngineCredentialConstraint("gemini")?.allowedKinds).toEqual([
      "api_key",
    ]);
  });
});

describe("validateCredentialForEngine", () => {
  it("accepts a matching provider + allowed kind (claude + anthropic oauth)", () => {
    const r = validateCredentialForEngine("claude", {
      provider: "anthropic",
      kind: "oauth_subscription",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.provider).toBe("anthropic");
  });

  it("accepts claude + anthropic api_key", () => {
    expect(
      validateCredentialForEngine("claude", {
        provider: "anthropic",
        kind: "api_key",
      }).ok,
    ).toBe(true);
  });

  it("accepts codex + openai oauth_subscription", () => {
    expect(
      validateCredentialForEngine("codex-xhigh", {
        provider: "openai",
        kind: "oauth_subscription",
      }).ok,
    ).toBe(true);
  });

  it("accepts kimi + openrouter api_key", () => {
    expect(
      validateCredentialForEngine("kimi", {
        provider: "openrouter",
        kind: "api_key",
      }).ok,
    ).toBe(true);
  });

  it("accepts minimax + openrouter api_key", () => {
    expect(
      validateCredentialForEngine("minimax", {
        provider: "openrouter",
        kind: "api_key",
      }).ok,
    ).toBe(true);
  });

  it("accepts zai + zai api_key", () => {
    expect(
      validateCredentialForEngine("zai", {
        provider: "zai",
        kind: "api_key",
      }).ok,
    ).toBe(true);
  });

  it("accepts gemini + google api_key", () => {
    expect(
      validateCredentialForEngine("gemini", {
        provider: "google",
        kind: "api_key",
      }).ok,
    ).toBe(true);
  });

  it("rejects a provider mismatch (codex needs openai, given zai)", () => {
    const r = validateCredentialForEngine("codex-xhigh", {
      provider: "zai",
      kind: "api_key",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/provider mismatch/i);
  });

  it("rejects codex with the WRONG kind (api_key) even on the right provider", () => {
    const r = validateCredentialForEngine("codex", {
      provider: "openai",
      kind: "api_key",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not allowed/i);
  });

  it("rejects an unknown engine", () => {
    const r = validateCredentialForEngine("nope", {
      provider: "anthropic",
      kind: "api_key",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown engine/i);
  });
});
