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
const { gh, setGhToken } = await import("./client.js");

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
