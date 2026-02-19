import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const { mockedExecFile } = vi.hoisted(() => ({
  mockedExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockedExecFile,
}));

import { runPublishPreflight } from "./publish.js";

function mockExecSuccess(stdout: string, stderr = ""): void {
  mockedExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _options: { encoding: string },
      callback: ExecCallback,
    ) => {
      callback(null, stdout, stderr);
    },
  );
}

function mockExecFailure(message: string, stderr = "", stdout = ""): void {
  mockedExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _options: { encoding: string },
      callback: ExecCallback,
    ) => {
      callback(new Error(message), stdout, stderr);
    },
  );
}

describe("runPublishPreflight()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok=true when origin is configured and dry-run push succeeds", async () => {
    mockExecSuccess("https://github.com/hivemoot-guard/hivemoot.git\n");
    mockExecSuccess("");

    const result = await runPublishPreflight();

    expect(result).toEqual({
      command: "git push --dry-run origin HEAD",
      ok: true,
      originUrl: "https://github.com/hivemoot-guard/hivemoot.git",
    });

    expect(mockedExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["remote", "get-url", "origin"],
      { encoding: "utf8" },
      expect.any(Function),
    );
    expect(mockedExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["push", "--dry-run", "origin", "HEAD"],
      { encoding: "utf8" },
      expect.any(Function),
    );
  });

  it("redacts credentials from origin URL", async () => {
    mockExecSuccess("https://token:x-oauth-basic@github.com/hivemoot-guard/hivemoot.git\n");
    mockExecSuccess("");

    const result = await runPublishPreflight();

    expect(result).toEqual({
      command: "git push --dry-run origin HEAD",
      ok: true,
      originUrl: "https://github.com/hivemoot-guard/hivemoot.git",
    });
  });

  it("returns a structured failure when origin remote cannot be resolved", async () => {
    mockExecFailure("fatal: not a git repository", "fatal: not a git repository");

    const result = await runPublishPreflight();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not resolve git origin remote");
    expect(result.error).toContain("fatal: not a git repository");
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it("returns a structured failure when dry-run push fails", async () => {
    mockExecSuccess("https://github.com/hivemoot/hivemoot.git\n");
    mockExecFailure(
      "push failed",
      "remote: Permission to hivemoot/hivemoot.git denied to hivemoot-guard.",
    );

    const result = await runPublishPreflight();

    expect(result).toEqual({
      command: "git push --dry-run origin HEAD",
      ok: false,
      originUrl: "https://github.com/hivemoot/hivemoot.git",
      error: "remote: Permission to hivemoot/hivemoot.git denied to hivemoot-guard.",
    });
  });

  it("redacts credentials from preflight error output", async () => {
    mockExecSuccess("https://github.com/hivemoot/hivemoot.git\n");
    mockExecFailure(
      "push failed",
      "fatal: unable to access 'https://token:x-oauth-basic@github.com/hivemoot/hivemoot.git/': The requested URL returned error: 403",
    );

    const result = await runPublishPreflight();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("https://github.com/hivemoot/hivemoot.git/");
    expect(result.error).not.toContain("token:x-oauth-basic@");
  });
});
