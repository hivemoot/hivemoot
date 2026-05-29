import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../config/types.js";

// Mock child_process with a promisify-compatible execFile
vi.mock("child_process", () => {
  const { promisify } = require("util");
  const mockFn = vi.fn();
  // util.promisify looks for a custom symbol; define execFile so promisify works
  mockFn[promisify.custom] = vi.fn();
  return { execFile: mockFn };
});

import { execFile } from "child_process";
import { promisify } from "util";

// Get the promisified mock — this is what client.ts actually calls
const execFilePromisified = promisify(execFile) as unknown as ReturnType<typeof vi.fn>;

// Dynamic import so the module picks up our mock
const { gh, setGhToken, ghWithHeaders, parseHeadersAndBody, ghPaginatedList } = await import("./client.js");

function mockSuccess(stdout: string) {
  execFilePromisified.mockResolvedValue({ stdout, stderr: "" });
}

function mockFailure(err: Error & { code?: string | number; stderr?: string }) {
  execFilePromisified.mockRejectedValue(err);
}

describe("gh()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns trimmed stdout on success", async () => {
    mockSuccess('  {"ok": true}\n');
    const result = await gh(["issue", "list"]);
    expect(result).toBe('{"ok": true}');
  });

  it("throws GH_NOT_FOUND when binary is missing (ENOENT)", async () => {
    mockFailure(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));

    await expect(gh(["version"])).rejects.toThrow(CliError);
    await expect(gh(["version"])).rejects.toMatchObject({
      code: "GH_NOT_FOUND",
      exitCode: 2,
    });
  });

  it("throws GH_NOT_AUTHENTICATED on auth-related stderr", async () => {
    mockFailure(
      Object.assign(new Error("failed"), {
        code: 1 as string | number,
        stderr: "To authenticate, run: gh auth login",
      }),
    );

    await expect(gh(["repo", "view"])).rejects.toThrow(CliError);
    await expect(gh(["repo", "view"])).rejects.toMatchObject({
      code: "GH_NOT_AUTHENTICATED",
      exitCode: 2,
    });
  });

  it("throws RATE_LIMITED on rate limit stderr", async () => {
    mockFailure(
      Object.assign(new Error("failed"), {
        code: 1 as string | number,
        stderr: "API rate limit exceeded",
      }),
    );

    await expect(gh(["api", "/user"])).rejects.toThrow(CliError);
    await expect(gh(["api", "/user"])).rejects.toMatchObject({
      code: "RATE_LIMITED",
      exitCode: 3,
    });
  });

  it("throws GH_ERROR for generic failures", async () => {
    mockFailure(
      Object.assign(new Error("something went wrong"), {
        code: 1 as string | number,
        stderr: "GraphQL error: something went wrong",
      }),
    );

    await expect(gh(["pr", "list"])).rejects.toThrow(CliError);
    await expect(gh(["pr", "list"])).rejects.toMatchObject({
      code: "GH_ERROR",
      exitCode: 1,
    });
  });

  it("does not misclassify authorization errors as auth-required", async () => {
    mockFailure(
      Object.assign(new Error("failed"), {
        code: 1 as string | number,
        stderr: "Resource not accessible by personal access token (authorization)",
      }),
    );

    await expect(gh(["api", "/repos"])).rejects.toMatchObject({
      code: "GH_ERROR",
    });
  });

  it("throws GH_ERROR with fallback message when stderr is empty", async () => {
    mockFailure(
      Object.assign(new Error(""), {
        code: 1 as string | number,
        stderr: "",
      }),
    );

    await expect(gh(["pr", "list"])).rejects.toThrow(CliError);
    await expect(gh(["pr", "list"])).rejects.toMatchObject({
      message: "gh command failed",
      code: "GH_ERROR",
    });
  });

  it("passes GH_TOKEN in env when setGhToken is called", async () => {
    setGhToken("test-token-123");
    mockSuccess("ok");

    await gh(["api", "user"]);

    // execFileAsync("gh", args, opts) — opts is at index 2
    const opts = execFilePromisified.mock.calls[0][2] as {
      env?: NodeJS.ProcessEnv;
    };
    expect(opts.env).toBeDefined();
    expect(opts.env!.GH_TOKEN).toBe("test-token-123");
    // Should also include process.env entries (e.g. PATH)
    expect(opts.env!.PATH).toBe(process.env.PATH);
  });

  it("does not pass env override when no token is set", async () => {
    // Reset module to clear token state
    vi.resetModules();

    // Re-mock child_process for the fresh import
    vi.mock("child_process", () => {
      const { promisify } = require("util");
      const mockFn = vi.fn();
      mockFn[promisify.custom] = vi.fn();
      return { execFile: mockFn };
    });

    const cp = await import("child_process");
    const freshExecFilePromisified = promisify(cp.execFile) as unknown as ReturnType<typeof vi.fn>;
    const { gh: freshGh } = await import("./client.js");

    freshExecFilePromisified.mockResolvedValue({ stdout: "ok", stderr: "" });

    await freshGh(["api", "user"]);

    const opts = freshExecFilePromisified.mock.calls[0][2] as {
      env?: NodeJS.ProcessEnv;
    };
    expect(opts.env).toBeUndefined();
  });

  it("includes --github-token in auth error message", async () => {
    mockFailure(
      Object.assign(new Error("failed"), {
        code: 1 as string | number,
        stderr: "To authenticate, run: gh auth login",
      }),
    );

    await expect(gh(["repo", "view"])).rejects.toThrow(
      /--github-token/,
    );
  });

  it("includes GITHUB_TOKEN in auth error message", async () => {
    mockFailure(
      Object.assign(new Error("failed"), {
        code: 1 as string | number,
        stderr: "not logged in to any hosts",
      }),
    );

    await expect(gh(["repo", "view"])).rejects.toThrow(
      /GITHUB_TOKEN/,
    );
  });
});

describe("parseHeadersAndBody()", () => {
  it("splits HTTP headers and body on blank line", () => {
    const raw = "HTTP/1.1 200 OK\nContent-Type: application/json\nX-Poll-Interval: 60\n\n[{\"id\":\"1\"}]";
    const { headers, body } = parseHeadersAndBody(raw);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-poll-interval"]).toBe("60");
    expect(body).toBe('[{"id":"1"}]');
  });

  it("lowercases header names", () => {
    const raw = "HTTP/1.1 200 OK\nLast-Modified: Mon, 10 Mar 2026 12:00:00 GMT\n\n[]";
    const { headers } = parseHeadersAndBody(raw);
    expect(headers["last-modified"]).toBe("Mon, 10 Mar 2026 12:00:00 GMT");
  });

  it("handles CRLF line endings", () => {
    const raw = "HTTP/1.1 200 OK\r\nX-Poll-Interval: 30\r\n\r\n[]";
    const { headers, body } = parseHeadersAndBody(raw);
    expect(headers["x-poll-interval"]).toBe("30");
    expect(body).toBe("[]");
  });

  it("returns empty headers when no blank line found", () => {
    const raw = "notaresponse";
    const { headers, body } = parseHeadersAndBody(raw);
    expect(headers).toEqual({});
    expect(body).toBe("notaresponse");
  });
});

describe("ghWithHeaders()", () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns notModified: false with parsed headers and body on success", async () => {
    const responseText = "HTTP/1.1 200 OK\nLast-Modified: Mon, 10 Mar 2026 12:00:00 GMT\nX-Poll-Interval: 60\n\n[{\"id\":\"1\"}]";
    execFilePromisified.mockResolvedValue({ stdout: responseText, stderr: "" });

    const result = await ghWithHeaders(["api", "-i", "/repos/foo/bar/notifications"]);

    expect(result.notModified).toBe(false);
    if (!result.notModified) {
      expect(result.headers["last-modified"]).toBe("Mon, 10 Mar 2026 12:00:00 GMT");
      expect(result.headers["x-poll-interval"]).toBe("60");
      expect(result.body).toBe('[{"id":"1"}]');
    }
  });

  it("returns notModified: true when gh exits with HTTP 304 in stderr", async () => {
    mockFailure(
      Object.assign(new Error("failed"), {
        code: 1 as string | number,
        stderr: "gh: HTTP 304",
      }),
    );

    const result = await ghWithHeaders(["api", "-i", "-H", "If-Modified-Since: Mon, 10 Mar 2026 12:00:00 GMT", "/repos/foo/bar/notifications"]);

    expect(result.notModified).toBe(true);
  });

  it("throws GH_NOT_AUTHENTICATED on auth error (not 304)", async () => {
    mockFailure(
      Object.assign(new Error("failed"), {
        code: 1 as string | number,
        stderr: "To authenticate, run: gh auth login",
      }),
    );

    await expect(ghWithHeaders(["api", "-i", "/repos/foo/bar/notifications"])).rejects.toMatchObject({
      code: "GH_NOT_AUTHENTICATED",
    });
  });

  it("throws GH_ERROR for generic failures", async () => {
    mockFailure(
      Object.assign(new Error("failed"), {
        code: 1 as string | number,
        stderr: "some other error",
      }),
    );

    await expect(ghWithHeaders(["api", "-i", "/repos/foo/bar/notifications"])).rejects.toMatchObject({
      code: "GH_ERROR",
    });
  });
});

describe("ghPaginatedList()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls gh with --paginate --slurp and the given api path", async () => {
    mockSuccess(JSON.stringify([[{ id: 1 }]]));

    await ghPaginatedList("/repos/foo/bar/notifications");

    expect(execFilePromisified.mock.calls[0][1]).toEqual([
      "api", "--paginate", "--slurp", "/repos/foo/bar/notifications",
    ]);
  });

  it("returns flattened items from a single page", async () => {
    mockSuccess(JSON.stringify([[{ id: 1 }, { id: 2 }]]));

    const result = await ghPaginatedList<{ id: number }>("/repos/foo/bar/items");

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("returns flattened items from multiple pages", async () => {
    mockSuccess(JSON.stringify([[{ id: 1 }], [{ id: 2 }, { id: 3 }]]));

    const result = await ghPaginatedList<{ id: number }>("/repos/foo/bar/items");

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("returns empty array for empty response", async () => {
    mockSuccess(JSON.stringify([[]]));

    const result = await ghPaginatedList("/repos/foo/bar/items");

    expect(result).toEqual([]);
  });

  it("throws CliError on invalid JSON response", async () => {
    mockSuccess("this is not json");

    await expect(ghPaginatedList("/repos/foo/bar/items")).rejects.toThrow(CliError);
    await expect(ghPaginatedList("/repos/foo/bar/items")).rejects.toMatchObject({
      code: "GH_ERROR",
    });
  });

  it("throws CliError when response is a non-array (e.g. object)", async () => {
    mockSuccess(JSON.stringify({ unexpected: true }));

    await expect(ghPaginatedList("/repos/foo/bar/items")).rejects.toThrow(CliError);
    await expect(ghPaginatedList("/repos/foo/bar/items")).rejects.toMatchObject({
      code: "GH_ERROR",
    });
  });
});
