import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  readRepoFile,
  getBranchSha,
  getDefaultBranch,
  createBranch,
  resetBranchToSha,
  writeFileToBranch,
  listOpenPRsForBranch,
  createPullRequest,
} from "./github-contents";

const TOKEN = "ghs_test_token";

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// readRepoFile
// ---------------------------------------------------------------------------

describe("readRepoFile", () => {
  it("decodes base64 content and returns sha", async () => {
    const raw = "version: 1\nteam:\n  name: test\n";
    const encoded = Buffer.from(raw, "utf-8").toString("base64");

    mockFetch(() =>
      jsonResponse({ content: encoded, sha: "abc123", encoding: "base64", type: "file" }),
    );

    const result = await readRepoFile("owner", "repo", ".github/hivemoot.yml", TOKEN);
    expect(result).not.toBeNull();
    expect(result!.content).toBe(raw);
    expect(result!.sha).toBe("abc123");
  });

  it("handles base64 with embedded newlines (GitHub's format)", async () => {
    const raw = "hello world";
    const encoded = Buffer.from(raw, "utf-8").toString("base64");
    // GitHub wraps every 60 chars with \n
    const withNewlines = encoded.replace(/(.{60})/g, "$1\n");

    mockFetch(() =>
      jsonResponse({ content: withNewlines, sha: "def456", encoding: "base64", type: "file" }),
    );

    const result = await readRepoFile("owner", "repo", "somefile.txt", TOKEN);
    expect(result!.content).toBe(raw);
  });

  it("returns null for 404", async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const result = await readRepoFile("owner", "repo", "missing.txt", TOKEN);
    expect(result).toBeNull();
  });

  it("throws on non-404 error", async () => {
    mockFetch(() => new Response(null, { status: 403 }));
    await expect(readRepoFile("owner", "repo", "file.txt", TOKEN)).rejects.toThrow(
      "GitHub contents read failed: 403",
    );
  });

  it("throws when response is a directory", async () => {
    mockFetch(() =>
      jsonResponse({ content: "", sha: "x", encoding: "base64", type: "dir" }),
    );
    await expect(readRepoFile("owner", "repo", "somedir", TOKEN)).rejects.toThrow(
      "Expected a file",
    );
  });

  it("includes the ref param in the request URL when provided", async () => {
    const raw = "content";
    const encoded = Buffer.from(raw, "utf-8").toString("base64");
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({ content: encoded, sha: "a1b2c3", encoding: "base64", type: "file" });
    });

    await readRepoFile("owner", "repo", "file.txt", TOKEN, "my-branch");
    expect(capturedUrl).toContain("ref=my-branch");
  });
});

// ---------------------------------------------------------------------------
// getBranchSha
// ---------------------------------------------------------------------------

describe("getBranchSha", () => {
  it("returns the SHA for an existing branch", async () => {
    mockFetch(() => jsonResponse({ object: { sha: "sha-abc" } }));
    const sha = await getBranchSha("owner", "repo", "main", TOKEN);
    expect(sha).toBe("sha-abc");
  });

  it("returns null for a missing branch", async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const sha = await getBranchSha("owner", "repo", "nonexistent", TOKEN);
    expect(sha).toBeNull();
  });

  it("throws on API errors", async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    await expect(getBranchSha("owner", "repo", "main", TOKEN)).rejects.toThrow(
      "GitHub ref lookup failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// createBranch
// ---------------------------------------------------------------------------

describe("createBranch", () => {
  it("creates a branch and returns ref info", async () => {
    mockFetch(() =>
      jsonResponse({
        ref: "refs/heads/my-branch",
        object: { sha: "base-sha" },
      }),
    );

    const result = await createBranch("owner", "repo", "my-branch", "base-sha", TOKEN);
    expect(result.ref).toBe("refs/heads/my-branch");
    expect(result.sha).toBe("base-sha");
  });

  it("is idempotent when branch already exists at same SHA", async () => {
    let callCount = 0;
    mockFetch((url) => {
      callCount++;
      if (callCount === 1) {
        // First call: create branch returns 422 (already exists)
        return new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 });
      }
      // Second call: getBranchSha lookup
      return jsonResponse({ object: { sha: "base-sha" } });
    });

    const result = await createBranch("owner", "repo", "my-branch", "base-sha", TOKEN);
    expect(result.sha).toBe("base-sha");
  });

  it("throws when branch exists at different SHA", async () => {
    let callCount = 0;
    mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 });
      }
      return jsonResponse({ object: { sha: "other-sha" } });
    });

    await expect(
      createBranch("owner", "repo", "my-branch", "base-sha", TOKEN),
    ).rejects.toThrow("already exists at other-sha");
  });
});

// ---------------------------------------------------------------------------
// resetBranchToSha
// ---------------------------------------------------------------------------

describe("resetBranchToSha", () => {
  it("force-patches the branch ref and returns updated info", async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedUrl = "";
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse({ ref: "refs/heads/my-branch", object: { sha: "new-sha" } });
    });

    const result = await resetBranchToSha("owner", "repo", "my-branch", "new-sha", TOKEN);
    expect(result).toEqual({ ref: "refs/heads/my-branch", sha: "new-sha" });
    expect(capturedUrl).toContain("/git/refs/heads/my-branch");
    expect(capturedBody.sha).toBe("new-sha");
    expect(capturedBody.force).toBe(true);
  });

  it("returns null when the branch does not exist (422)", async () => {
    mockFetch(() => new Response(null, { status: 422 }));
    const result = await resetBranchToSha("owner", "repo", "nonexistent", "sha", TOKEN);
    expect(result).toBeNull();
  });

  it("throws on API errors", async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    await expect(resetBranchToSha("owner", "repo", "my-branch", "sha", TOKEN)).rejects.toThrow(
      "GitHub reset branch failed: 500",
    );
  });
});

// ---------------------------------------------------------------------------
// writeFileToBranch
// ---------------------------------------------------------------------------

describe("writeFileToBranch", () => {
  it("sends base64-encoded content with correct fields", async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse({ content: {}, commit: {} });
    });

    await writeFileToBranch(
      "owner",
      "repo",
      ".github/hivemoot.yml",
      "version: 1\n",
      "chore: update roles",
      "my-branch",
      TOKEN,
      "file-sha",
    );

    expect(capturedBody.message).toBe("chore: update roles");
    expect(capturedBody.branch).toBe("my-branch");
    expect(capturedBody.sha).toBe("file-sha");
    // Content should be valid base64 that decodes back to the original
    const decoded = Buffer.from(capturedBody.content as string, "base64").toString("utf-8");
    expect(decoded).toBe("version: 1\n");
  });

  it("omits sha field when creating a new file", async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse({ content: {}, commit: {} });
    });

    await writeFileToBranch(
      "owner",
      "repo",
      "newfile.txt",
      "hello",
      "create file",
      "my-branch",
      TOKEN,
      // no fileSha → create mode
    );

    expect(capturedBody.sha).toBeUndefined();
  });

  it("throws on failure", async () => {
    mockFetch(() => new Response("Conflict", { status: 409 }));
    await expect(
      writeFileToBranch("owner", "repo", "file.txt", "content", "msg", "branch", TOKEN),
    ).rejects.toThrow("GitHub contents write failed: 409");
  });
});

// ---------------------------------------------------------------------------
// listOpenPRsForBranch
// ---------------------------------------------------------------------------

describe("listOpenPRsForBranch", () => {
  it("returns mapped PR objects", async () => {
    mockFetch(() =>
      jsonResponse([
        { number: 42, title: "Edit roles", head: { label: "owner:my-branch" }, html_url: "https://github.com/owner/repo/pull/42" },
      ]),
    );

    const prs = await listOpenPRsForBranch("owner", "repo", "my-branch", TOKEN);
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(42);
    expect(prs[0].headRef).toBe("owner:my-branch");
    expect(prs[0].url).toBe("https://github.com/owner/repo/pull/42");
  });

  it("returns empty array when no PRs match", async () => {
    mockFetch(() => jsonResponse([]));
    const prs = await listOpenPRsForBranch("owner", "repo", "my-branch", TOKEN);
    expect(prs).toEqual([]);
  });

  it("includes owner:branch in the head filter", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse([]);
    });

    await listOpenPRsForBranch("myorg", "myrepo", "edit-branch", TOKEN);
    expect(capturedUrl).toContain("head=myorg%3Aedit-branch");
  });
});

// ---------------------------------------------------------------------------
// getDefaultBranch
// ---------------------------------------------------------------------------

describe("getDefaultBranch", () => {
  it("returns the default_branch field from the repo response", async () => {
    mockFetch(() => jsonResponse({ default_branch: "trunk" }));
    const branch = await getDefaultBranch("owner", "repo", TOKEN);
    expect(branch).toBe("trunk");
  });

  it("returns 'main' when default branch is main", async () => {
    mockFetch(() => jsonResponse({ default_branch: "main" }));
    const branch = await getDefaultBranch("owner", "repo", TOKEN);
    expect(branch).toBe("main");
  });

  it("throws on API error", async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    await expect(getDefaultBranch("owner", "repo", TOKEN)).rejects.toThrow(
      "GitHub repo lookup failed: 404",
    );
  });
});

// ---------------------------------------------------------------------------
// createPullRequest
// ---------------------------------------------------------------------------

describe("createPullRequest", () => {
  it("creates a PR targeting the specified base branch", async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse({
        number: 99,
        title: "Edit agent roles",
        head: { label: "owner:edit-roles" },
        html_url: "https://github.com/owner/repo/pull/99",
      });
    });

    const pr = await createPullRequest(
      "owner",
      "repo",
      "Edit agent roles",
      "edit-roles",
      "Updates to role instructions",
      TOKEN,
      "main",
    );

    expect(pr.number).toBe(99);
    expect(pr.title).toBe("Edit agent roles");
    expect(capturedBody.base).toBe("main");
    expect(capturedBody.head).toBe("edit-roles");
  });

  it("uses the provided base branch (not always 'main')", async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse({
        number: 100,
        title: "Edit roles",
        head: { label: "owner:edit-roles" },
        html_url: "https://github.com/owner/repo/pull/100",
      });
    });

    await createPullRequest("owner", "repo", "Edit roles", "edit-roles", "body", TOKEN, "master");
    expect(capturedBody.base).toBe("master");
  });

  it("throws on failure", async () => {
    mockFetch(() => new Response("Unprocessable", { status: 422 }));
    await expect(
      createPullRequest("owner", "repo", "title", "branch", "body", TOKEN, "main"),
    ).rejects.toThrow("GitHub create PR failed: 422");
  });
});
