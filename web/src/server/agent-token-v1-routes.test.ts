/**
 * Unit tests for the agent-tokens V1 route helpers.
 *
 * Helpers under test:
 *   - parseExpiresIn (request-side duration → ISO timestamp)
 *   - parseV1RequestPolicy (camelCase wire → snake_case storage)
 *   - projectV1ResponsePolicy (snake_case storage → camelCase wire)
 *   - projectV1TokenSummary (full summary projection)
 *   - buildMutationAuditEntry (audit entry shape)
 *   - mapV1StorageErrorToResponse (error → HTTP status)
 */

import { describe, it, expect } from "vitest";
import {
  parseExpiresIn,
  parseV1RequestPolicy,
  projectV1ResponsePolicy,
  projectV1TokenSummary,
  buildMutationAuditEntry,
  mapV1StorageErrorToResponse,
  AGENT_TOKENS_V1_ERROR,
} from "./agent-token-v1-routes";
import {
  TokenNameTakenError,
  TokenNotFoundError,
  TokenLimitReachedError,
  InvalidExpiresAtError,
  type AgentTokenSummaryV1,
} from "./agent-token-v1";
import { CapabilityValidationError } from "./agent-token-capabilities";
import { LockTimeoutError } from "./redis-lock";

// ---------------------------------------------------------------------------
// parseExpiresIn
// ---------------------------------------------------------------------------

describe("parseExpiresIn", () => {
  it("absent or null → expiresAt: null (no-expiry token)", () => {
    expect(parseExpiresIn(undefined)).toEqual({ ok: true, expiresAt: null });
    expect(parseExpiresIn(null)).toEqual({ ok: true, expiresAt: null });
  });

  it("'30d' → ISO timestamp ~30d in the future", () => {
    const before = Date.now();
    const result = parseExpiresIn("30d");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiresAt).not.toBeNull();
      const ms = new Date(result.expiresAt!).getTime() - before;
      // Allow small slack for the moment between Date.now() inside vs outside.
      expect(ms).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 100);
      expect(ms).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 100);
    }
  });

  it("'12h' / '60m' both parse correctly", () => {
    const r1 = parseExpiresIn("12h");
    const r2 = parseExpiresIn("60m");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("trims + lowercases input ('  30D ' → 30d)", () => {
    const result = parseExpiresIn("  30D  ");
    expect(result.ok).toBe(true);
  });

  it("non-string → ok: false", () => {
    expect(parseExpiresIn(30)).toMatchObject({ ok: false });
    expect(parseExpiresIn({})).toMatchObject({ ok: false });
    expect(parseExpiresIn(true)).toMatchObject({ ok: false });
  });

  it("malformed pattern ('30 d' / 'd30' / '0d' / '-1d') → ok: false", () => {
    expect(parseExpiresIn("30 d")).toMatchObject({ ok: false });
    expect(parseExpiresIn("d30")).toMatchObject({ ok: false });
    expect(parseExpiresIn("0d")).toMatchObject({ ok: false });
    expect(parseExpiresIn("-1d")).toMatchObject({ ok: false });
  });

  it("over-365d cap → ok: false (avoids accidental near-infinite tokens)", () => {
    expect(parseExpiresIn("366d")).toMatchObject({ ok: false });
    expect(parseExpiresIn("365d")).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// parseV1RequestPolicy
// ---------------------------------------------------------------------------

describe("parseV1RequestPolicy", () => {
  it("absent / null → policy: undefined (legacy permissive)", () => {
    expect(parseV1RequestPolicy(undefined)).toEqual({
      ok: true,
      policy: undefined,
    });
    expect(parseV1RequestPolicy(null)).toEqual({
      ok: true,
      policy: undefined,
    });
  });

  it("V1.5 (allowedRepos only) → snake_case allowed_repos, no allowed_permissions key", () => {
    const result = parseV1RequestPolicy({
      allowedRepos: ["hivemoot/foxstoria"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy).toEqual({
        allowed_repos: ["hivemoot/foxstoria"],
      });
      expect("allowed_permissions" in (result.policy ?? {})).toBe(false);
    }
  });

  it("V1.6 (allowedRepos + allowedPermissions) → both translated", () => {
    const result = parseV1RequestPolicy({
      allowedRepos: ["hivemoot/foxstoria"],
      allowedPermissions: { contents: "read", issues: "write" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy).toEqual({
        allowed_repos: ["hivemoot/foxstoria"],
        allowed_permissions: { contents: "read", issues: "write" },
      });
    }
  });

  it("intentional reject-all (allowedRepos: []) translates faithfully", () => {
    const result = parseV1RequestPolicy({ allowedRepos: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy).toEqual({ allowed_repos: [] });
    }
  });

  it("V1.6-only (allowedPermissions without allowedRepos) → rejected", () => {
    // Storage type requires allowed_repos when policy is set; the
    // boundary rejects rather than silently materializing a bad
    // envelope shape.
    const result = parseV1RequestPolicy({
      allowedPermissions: { contents: "read" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/allowedRepos is required/i);
    }
  });

  it("empty object {} → rejected (ambiguous: legacy-permissive vs reject-all)", () => {
    const result = parseV1RequestPolicy({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/empty|set allowedRepos/i);
    }
  });

  it("non-object input → rejected", () => {
    expect(parseV1RequestPolicy("hivemoot/foo")).toMatchObject({ ok: false });
    expect(parseV1RequestPolicy([])).toMatchObject({ ok: false });
    expect(parseV1RequestPolicy(42)).toMatchObject({ ok: false });
  });

  it("allowedRepos non-array → rejected", () => {
    expect(
      parseV1RequestPolicy({ allowedRepos: "hivemoot/foo" }),
    ).toMatchObject({ ok: false });
  });

  it("allowedRepos with non-string entry → rejected", () => {
    expect(
      parseV1RequestPolicy({ allowedRepos: ["hivemoot/foo", 42] }),
    ).toMatchObject({ ok: false });
  });

  it("allowedPermissions with invalid level → rejected", () => {
    const result = parseV1RequestPolicy({
      allowedRepos: ["hivemoot/foo"],
      allowedPermissions: { contents: "owner" }, // not in {read, write, admin}
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/contents/);
      expect(result.message).toMatch(/read.*write.*admin/i);
    }
  });

  it("allowedPermissions non-object → rejected", () => {
    expect(
      parseV1RequestPolicy({
        allowedRepos: [],
        allowedPermissions: ["contents:read"],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseV1RequestPolicy({
        allowedRepos: [],
        allowedPermissions: null,
      }),
    ).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// projectV1ResponsePolicy
// ---------------------------------------------------------------------------

describe("projectV1ResponsePolicy", () => {
  it("undefined / null → null (envelope had no policy)", () => {
    expect(projectV1ResponsePolicy(undefined)).toBeNull();
    expect(projectV1ResponsePolicy(null)).toBeNull();
  });

  it("V1.5 storage → camelCase wire", () => {
    expect(
      projectV1ResponsePolicy({ allowed_repos: ["hivemoot/foo"] }),
    ).toEqual({ allowedRepos: ["hivemoot/foo"] });
  });

  it("V1.6 storage → camelCase wire (both fields)", () => {
    expect(
      projectV1ResponsePolicy({
        allowed_repos: ["hivemoot/foo"],
        allowed_permissions: { contents: "read" },
      }),
    ).toEqual({
      allowedRepos: ["hivemoot/foo"],
      allowedPermissions: { contents: "read" },
    });
  });

  it("reject-all (allowed_repos: []) → allowedRepos: []", () => {
    expect(projectV1ResponsePolicy({ allowed_repos: [] })).toEqual({
      allowedRepos: [],
    });
  });

  it("V1.5 (no allowed_permissions) omits the wire key entirely", () => {
    const result = projectV1ResponsePolicy({
      allowed_repos: ["hivemoot/foo"],
    });
    expect(result).not.toBeNull();
    expect("allowedPermissions" in (result ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// projectV1TokenSummary
// ---------------------------------------------------------------------------

describe("projectV1TokenSummary", () => {
  const baseSummary: AgentTokenSummaryV1 = {
    name: "worker",
    agent_role: "drone",
    capabilities: ["agent_health.report", "tasks.claim"],
    fingerprint: "01234567",
    createdAt: "2026-04-27T10:00:00.000Z",
    createdBy: "operator",
    expiresAt: null,
  };

  it("translates summary with no policy → policy: null on wire", () => {
    expect(projectV1TokenSummary(baseSummary)).toEqual({
      name: "worker",
      agent_role: "drone",
      capabilities: ["agent_health.report", "tasks.claim"],
      fingerprint: "01234567",
      createdAt: "2026-04-27T10:00:00.000Z",
      createdBy: "operator",
      expiresAt: null,
      policy: null,
    });
  });

  it("translates summary with V1.6 policy → camelCase on wire", () => {
    const result = projectV1TokenSummary({
      ...baseSummary,
      policy: {
        allowed_repos: ["hivemoot/foo"],
        allowed_permissions: { contents: "read" },
      },
    });
    expect(result.policy).toEqual({
      allowedRepos: ["hivemoot/foo"],
      allowedPermissions: { contents: "read" },
    });
  });
});

// ---------------------------------------------------------------------------
// buildMutationAuditEntry
// ---------------------------------------------------------------------------

describe("buildMutationAuditEntry", () => {
  it("issue: fingerprint = operator's, name = subject's, actor = operator's name", () => {
    const entry = buildMutationAuditEntry({
      action: "issue",
      operator: { fingerprint: "abcdef01", name: "admin" },
      subjectName: "new-worker",
      detail: { agent_role: "drone", capabilities: ["agent_health.report"] },
    });
    expect(entry.fingerprint).toBe("abcdef01");
    expect(entry.name).toBe("new-worker");
    expect(entry.action).toBe("issue");
    expect(entry.actor).toBe("admin");
    expect(entry.detail).toEqual({
      agent_role: "drone",
      capabilities: ["agent_health.report"],
    });
    expect(typeof entry.ts).toBe("string");
    // ISO 8601 + UTC marker
    expect(entry.ts).toMatch(/T.*Z$/);
  });

  it("revoke: minimal entry without detail", () => {
    const entry = buildMutationAuditEntry({
      action: "revoke",
      operator: { fingerprint: "abcdef01", name: "admin" },
      subjectName: "old-worker",
    });
    expect(entry.action).toBe("revoke");
    expect(entry.name).toBe("old-worker");
    expect(entry.actor).toBe("admin");
    expect("detail" in entry).toBe(false);
  });

  it("set_capabilities: detail carries from + to lists", () => {
    const entry = buildMutationAuditEntry({
      action: "set_capabilities",
      operator: { fingerprint: "abcdef01", name: "admin" },
      subjectName: "worker",
      detail: { from: ["tasks.claim"], to: ["tasks.claim", "rooms.read"] },
    });
    expect(entry.detail).toEqual({
      from: ["tasks.claim"],
      to: ["tasks.claim", "rooms.read"],
    });
  });

  it("SECURITY: never includes raw token / bearer field", () => {
    const entry = buildMutationAuditEntry({
      action: "issue",
      operator: { fingerprint: "abcdef01", name: "admin" },
      subjectName: "worker",
    });
    const json = JSON.stringify(entry);
    expect(json).not.toMatch(/"token"\s*:/);
    expect(json).not.toMatch(/"bearer"\s*:/);
    expect(json).not.toMatch(/hmt_/); // no raw bearer prefix
  });
});

// ---------------------------------------------------------------------------
// mapV1StorageErrorToResponse
// ---------------------------------------------------------------------------

describe("mapV1StorageErrorToResponse", () => {
  const ctx = { route: "POST /api/agent-tokens", installationId: "12345" };

  it("TokenNameTakenError → 409 NAME_TAKEN", async () => {
    const res = mapV1StorageErrorToResponse(
      new TokenNameTakenError("12345", "worker"),
      { ...ctx, name: "worker" },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(AGENT_TOKENS_V1_ERROR.NAME_TAKEN);
    expect(body.name).toBe("worker");
  });

  it("TokenNotFoundError → 404 TOKEN_NOT_FOUND", async () => {
    const res = mapV1StorageErrorToResponse(
      new TokenNotFoundError("12345", "missing"),
      { ...ctx, name: "missing" },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe(AGENT_TOKENS_V1_ERROR.TOKEN_NOT_FOUND);
  });

  it("TokenLimitReachedError → 422 TOKEN_LIMIT_REACHED", async () => {
    const res = mapV1StorageErrorToResponse(
      new TokenLimitReachedError("12345", 20),
      ctx,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe(AGENT_TOKENS_V1_ERROR.TOKEN_LIMIT_REACHED);
  });

  it("InvalidExpiresAtError → 400 INVALID_EXPIRES_IN", async () => {
    const res = mapV1StorageErrorToResponse(
      new InvalidExpiresAtError("not-a-date", "not a valid ISO 8601 timestamp"),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(AGENT_TOKENS_V1_ERROR.INVALID_EXPIRES_IN);
  });

  it("CapabilityValidationError → 400 INVALID_CAPABILITIES with field+value", async () => {
    const res = mapV1StorageErrorToResponse(
      new CapabilityValidationError("name", "bad name", "lowercase ASCII"),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES);
    expect(body.field).toBe("name");
    expect(body.value).toBe("bad name");
  });

  it("LockTimeoutError → 503 LOCK_TIMEOUT", async () => {
    const res = mapV1StorageErrorToResponse(
      new LockTimeoutError("hive:v1:lock:agent-token:12345:worker"),
      ctx,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe(AGENT_TOKENS_V1_ERROR.LOCK_TIMEOUT);
  });

  it("unknown error → 500 SERVER_ERROR (opaque, no leak)", async () => {
    const res = mapV1StorageErrorToResponse(
      new Error("internal SQL state INVALID_DETAIL"),
      ctx,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe(AGENT_TOKENS_V1_ERROR.SERVER_ERROR);
    // Critical: don't leak the raw error message to clients.
    expect(body.message).not.toContain("INVALID_DETAIL");
    expect(body.message).not.toContain("SQL");
  });
});
