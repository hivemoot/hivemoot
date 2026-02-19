import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecOptions = {
  encoding: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
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

function mockExecFailure(error: Error, stderr = "", stdout = ""): void {
  mockedExecFile.mockImplementationOnce(
    (
      _cmd: string,
      _args: string[],
      _options: ExecOptions,
      callback: ExecCallback,
    ) => {
      callback(error, stdout, stderr);
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
    mockExecFailure(new Error("fatal: not a git repository"), "fatal: not a git repository");

    const result = await runPublishPreflight();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not resolve git origin remote");
    expect(result.error).toContain("fatal: not a git repository");
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it("returns a structured failure when dry-run push fails", async () => {
    mockExecSuccess("https://github.com/hivemoot/hivemoot.git\n");
    mockExecFailure(
      new Error("push failed"),
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
      new Error("push failed"),
      "fatal: unable to access 'https://token:x-oauth-basic@github.com/hivemoot/hivemoot.git/': The requested URL returned error: 403",
    );

    const result = await runPublishPreflight();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("https://github.com/hivemoot/hivemoot.git/");
    expect(result.error).not.toContain("token:x-oauth-basic@");
  });

  it("returns structured timeout failures for hanging git commands", async () => {
    mockExecSuccess("https://github.com/hivemoot/hivemoot.git\n");
    mockExecFailure(
      Object.assign(new Error("Command failed: git push --dry-run origin HEAD"), {
        killed: true,
        signal: "SIGTERM",
      }),
    );

    const result = await runPublishPreflight();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("git command timed out after 15000ms");
  });

  it("returns structured prompt-disabled failures when auth prompts are blocked", async () => {
    mockExecSuccess("https://github.com/hivemoot/hivemoot.git\n");
    mockExecFailure(
      new Error("push failed"),
      "fatal: could not read Username for 'https://token:x-oauth-basic@github.com/hivemoot/hivemoot.git': terminal prompts disabled",
    );

    const result = await runPublishPreflight();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("git authentication prompt blocked (GIT_TERMINAL_PROMPT=0):");
    expect(result.error).toContain("https://github.com/hivemoot/hivemoot.git");
    expect(result.error).not.toContain("token:x-oauth-basic@");
  });
});
