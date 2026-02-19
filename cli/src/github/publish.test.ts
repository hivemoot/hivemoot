import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecOptions = {
  encoding: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
};
type MockExecError = Error & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

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
      _options: ExecOptions,
      callback: ExecCallback,
    ) => {
      callback(null, stdout, stderr);
    },
  );
}

function mockExecFailure(
  message: string,
  stderr = "",
  stdout = "",
  override?: Partial<MockExecError>,
): void {
  mockedExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _options: ExecOptions,
      callback: ExecCallback,
    ) => {
      const err = new Error(message) as MockExecError;
      if (override?.killed !== undefined) err.killed = override.killed;
      if (override?.signal !== undefined) err.signal = override.signal;
      callback(err, stdout, stderr);
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
      expect.objectContaining({
        encoding: "utf8",
        timeout: 15_000,
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: "0",
        }),
      }),
      expect.any(Function),
    );
    expect(mockedExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["push", "--dry-run", "origin", "HEAD"],
      expect.objectContaining({
        encoding: "utf8",
        timeout: 15_000,
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: "0",
        }),
      }),
      expect.any(Function),
    );
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

  it("redacts credentials from authenticated origin URL output", async () => {
    mockExecSuccess("https://x-access-token:ghp_secret@github.com/hivemoot/hivemoot.git\n");
    mockExecSuccess("");

    const result = await runPublishPreflight();

    expect(result).toEqual({
      command: "git push --dry-run origin HEAD",
      ok: true,
      originUrl: "https://github.com/hivemoot/hivemoot.git",
    });
  });

  it("redacts credentials from push errors before returning", async () => {
    mockExecSuccess("https://x-access-token:ghp_secret@github.com/hivemoot/hivemoot.git\n");
    mockExecFailure(
      "push failed",
      "fatal: unable to access 'https://x-access-token:ghp_secret@github.com/hivemoot/hivemoot.git/': The requested URL returned error: 403",
    );

    const result = await runPublishPreflight();

    expect(result.ok).toBe(false);
    expect(result.originUrl).toBe("https://github.com/hivemoot/hivemoot.git");
    expect(result.error).toContain("https://github.com/hivemoot/hivemoot.git/");
    expect(result.error).not.toContain("ghp_secret");
    expect(result.error).not.toContain("x-access-token");
  });

  it("returns deterministic timeout errors", async () => {
    mockExecSuccess("https://github.com/hivemoot/hivemoot.git\n");
    mockExecFailure(
      "Command timed out",
      "",
      "",
      { killed: true, signal: "SIGTERM" },
    );

    const result = await runPublishPreflight();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("git command timed out after 15000ms");
  });

  it("returns prompt-disabled errors without leaking credentials", async () => {
    mockExecSuccess("https://github.com/hivemoot/hivemoot.git\n");
    mockExecFailure(
      "push failed",
      "fatal: could not read Username for 'https://x-access-token:ghp_secret@github.com/hivemoot/hivemoot.git': terminal prompts disabled",
    );

    const result = await runPublishPreflight();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("git authentication prompt blocked (GIT_TERMINAL_PROMPT=0):");
    expect(result.error).toContain("https://github.com/hivemoot/hivemoot.git");
    expect(result.error).not.toContain("ghp_secret");
    expect(result.error).not.toContain("x-access-token");
  });
});
