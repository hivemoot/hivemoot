import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));

vi.mock("@/server/env", () => ({
  validateEnv: vi.fn(),
}));

vi.mock("@/server/github-auth", () => ({
  generateAppJwt: vi.fn().mockReturnValue("mock-jwt"),
  generateInstallationToken: vi.fn().mockResolvedValue("mock-token"),
}));

vi.mock("@/server/github-contents", () => ({
  readRepoFile: vi.fn(),
  getBranchSha: vi.fn(),
  getDefaultBranch: vi.fn(),
  createBranch: vi.fn(),
  resetBranchToSha: vi.fn(),
  writeFileToBranch: vi.fn(),
  listOpenPRsForBranch: vi.fn(),
  createPullRequest: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { validateEnv } from "@/server/env";
import {
  readRepoFile,
  getBranchSha,
  getDefaultBranch,
  createBranch,
  resetBranchToSha,
  writeFileToBranch,
  listOpenPRsForBranch,
  createPullRequest,
} from "@/server/github-contents";
import { GET, PUT } from "./route";

const VALID_YAML = `team:
  roles:
    worker:
      description: Does the work
      instructions: Work hard and follow all instructions carefully
    scout:
      description: Finds things
      instructions: Look carefully at what is there
`;

const YAML_WITH_COMMENT = `# Team configuration for hivemoot
team:
  roles:
    worker:
      description: Does the work
      instructions: Work hard
`;

const BASE_URL = "https://example.com/api/repos/hivemoot/hivemoot/roles";

function makeGetRequest() {
  return new NextRequest(BASE_URL);
}

function makePutRequest(body: unknown) {
  return new NextRequest(BASE_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const AUTH_SUCCESS = {
  ok: true as const,
  session: {
    installationId: "inst-1",
    userId: 42,
    userLogin: "test-user",
  },
  redis: {} as never,
  keyring: new Map<string, Buffer>(),
  activeKeyVersion: "v1",
};

const ENV_SUCCESS = {
  ok: true as const,
  config: {
    githubAppId: "app-123",
    githubAppPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
    redisRestUrl: "https://redis.example.com",
    redisRestToken: "token-123",
    byokActiveKeyVersion: "v1",
    byokMasterKeysJson: null,
  },
};

const FILE_RESPONSE = {
  content: VALID_YAML,
  sha: "file-sha-abc123",
};

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(authenticateByokRequest).mockResolvedValue(AUTH_SUCCESS);
  vi.mocked(validateEnv).mockReturnValue(ENV_SUCCESS);
  vi.mocked(listOpenPRsForBranch).mockResolvedValue([]);
  vi.mocked(readRepoFile).mockResolvedValue(FILE_RESPONSE);
  vi.mocked(getDefaultBranch).mockResolvedValue("main");
  vi.mocked(getBranchSha).mockResolvedValue("base-sha-xyz");
  vi.mocked(resetBranchToSha).mockResolvedValue("reset-ok");
  vi.mocked(writeFileToBranch).mockResolvedValue(undefined);
  vi.mocked(createPullRequest).mockResolvedValue({ number: 99, url: "https://github.com/hivemoot/hivemoot/pull/99" });
});

// ---------------------------------------------------------------------------
// GET /api/repos/[owner]/[repo]/roles
// ---------------------------------------------------------------------------

describe("GET /api/repos/[owner]/[repo]/roles", () => {
  it("returns roles when no pending PR exists", async () => {
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toHaveLength(2);
    expect(body.roles[0].name).toBe("worker");
    expect(body.roles[0].description).toBe("Does the work");
    expect(body.source).toBe("main");
    expect(body.fileSha).toBe("file-sha-abc123");
  });

  it("reads from the edit branch and sets source to pending-pr when a PR is open", async () => {
    vi.mocked(listOpenPRsForBranch).mockResolvedValue([
      { number: 5, url: "https://github.com/hivemoot/hivemoot/pull/5" },
    ]);

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("pending-pr:5");
    // readRepoFile should have been called with the edit branch ref
    expect(readRepoFile).toHaveBeenCalledWith(
      "hivemoot",
      "hivemoot",
      ".github/hivemoot.yml",
      "mock-token",
      "hivemoot-role-edits",
    );
  });

  it("returns 401 when auth fails", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_not_authenticated" }, { status: 401 }),
    });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("returns 503 when env is misconfigured", async () => {
    vi.mocked(validateEnv).mockReturnValue({ ok: false, missing: ["REDIS_REST_URL"] });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("server_misconfiguration");
  });

  it("returns 503 when GitHub App keys are missing", async () => {
    vi.mocked(validateEnv).mockReturnValue({
      ok: true,
      config: { ...ENV_SUCCESS.config, githubAppId: undefined },
    } as never);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("server_misconfiguration");
  });

  it("returns 404 when hivemoot.yml is not found", async () => {
    vi.mocked(readRepoFile).mockResolvedValue(null);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("config_not_found");
  });

  it("returns 422 when hivemoot.yml cannot be parsed", async () => {
    vi.mocked(readRepoFile).mockResolvedValue({ content: "not: valid: yaml: :::", sha: "sha1" });

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("config_parse_error");
  });

  it("returns 500 when a GitHub API call throws", async () => {
    vi.mocked(listOpenPRsForBranch).mockRejectedValue(new Error("GitHub API unavailable"));

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("server_error");
  });
});

// ---------------------------------------------------------------------------
// PUT /api/repos/[owner]/[repo]/roles
// ---------------------------------------------------------------------------

describe("PUT /api/repos/[owner]/[repo]/roles", () => {
  const VALID_PUT_BODY = {
    roleName: "worker",
    description: "Updated description",
    instructions: "Updated instructions",
    fileSha: "file-sha-abc123",
  };

  it("creates a new branch and PR when none exists", async () => {
    vi.mocked(resetBranchToSha).mockResolvedValue(null); // branch doesn't exist yet

    const res = await PUT(makePutRequest(VALID_PUT_BODY));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prNumber).toBe(99);
    expect(body.source).toBe("pending-pr:99");
    expect(createBranch).toHaveBeenCalled();
    expect(createPullRequest).toHaveBeenCalled();
  });

  it("resets the stale branch instead of creating when resetBranchToSha succeeds", async () => {
    vi.mocked(resetBranchToSha).mockResolvedValue("reset-ok");

    const res = await PUT(makePutRequest(VALID_PUT_BODY));

    expect(res.status).toBe(201);
    expect(createBranch).not.toHaveBeenCalled();
  });

  it("updates the existing PR without creating a new branch or PR", async () => {
    vi.mocked(listOpenPRsForBranch).mockResolvedValue([
      { number: 7, url: "https://github.com/hivemoot/hivemoot/pull/7" },
    ]);

    const res = await PUT(makePutRequest(VALID_PUT_BODY));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prNumber).toBe(7);
    expect(body.source).toBe("pending-pr:7");
    expect(createBranch).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("returns 401 when auth fails", async () => {
    vi.mocked(authenticateByokRequest).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "byok_not_authenticated" }, { status: 401 }),
    });

    const res = await PUT(makePutRequest(VALID_PUT_BODY));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new NextRequest(BASE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not valid json {",
    });

    const res = await PUT(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_body");
  });

  it("returns 400 for empty roleName", async () => {
    const res = await PUT(makePutRequest({ ...VALID_PUT_BODY, roleName: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_role_name");
  });

  it("returns 400 for roleName exceeding 100 characters", async () => {
    const res = await PUT(makePutRequest({ ...VALID_PUT_BODY, roleName: "a".repeat(101) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_role_name");
  });

  it("returns 400 when description is not a string", async () => {
    const res = await PUT(makePutRequest({ ...VALID_PUT_BODY, description: 123 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_description");
  });

  it("returns 400 when fileSha is missing", async () => {
    const res = await PUT(makePutRequest({ ...VALID_PUT_BODY, fileSha: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_file_sha");
  });

  it("returns 404 when hivemoot.yml is not found", async () => {
    vi.mocked(readRepoFile).mockResolvedValue(null);

    const res = await PUT(makePutRequest(VALID_PUT_BODY));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("config_not_found");
  });

  it("returns 409 when fileSha does not match the current file", async () => {
    const res = await PUT(makePutRequest({ ...VALID_PUT_BODY, fileSha: "stale-sha" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("conflict");
  });

  it("returns 404 when the roleName does not exist in the config", async () => {
    const res = await PUT(makePutRequest({ ...VALID_PUT_BODY, roleName: "nonexistent" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("role_not_found");
  });

  it("returns 500 when a GitHub API call throws", async () => {
    vi.mocked(listOpenPRsForBranch).mockRejectedValue(new Error("GitHub API unavailable"));

    const res = await PUT(makePutRequest(VALID_PUT_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("server_error");
  });

  it("preserves YAML comments after a role edit (round-trip safety)", async () => {
    vi.mocked(readRepoFile).mockResolvedValue({ content: YAML_WITH_COMMENT, sha: "file-sha-abc123" });
    vi.mocked(resetBranchToSha).mockResolvedValue(null);

    const res = await PUT(makePutRequest({
      roleName: "worker",
      description: "New description",
      instructions: "New instructions",
      fileSha: "file-sha-abc123",
    }));

    expect(res.status).toBe(201);
    // Verify writeFileToBranch was called with content that still has the comment
    const writtenContent = vi.mocked(writeFileToBranch).mock.calls[0][3] as string;
    expect(writtenContent).toContain("# Team configuration for hivemoot");
    expect(writtenContent).toContain("New description");
    expect(writtenContent).toContain("New instructions");
  });
});
