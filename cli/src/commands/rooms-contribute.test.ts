import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../config/types.js";

vi.mock("../hivemoot/client.js", () => ({
  hivemootPost: vi.fn(),
}));

import { hivemootPost } from "../hivemoot/client.js";
import { roomsContributeCommand } from "./rooms-contribute.js";
import type { SubmitContributionResponse } from "../hivemoot/types.js";

const mockedPost = vi.mocked(hivemootPost);

const VALID_ID = "8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedPost.mockResolvedValue({ sequence: 7 } as SubmitContributionResponse);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeTmpFile(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hivemoot-contribute-"));
  const p = path.join(dir, name);
  await writeFile(p, contents, "utf8");
  return p;
}

describe("roomsContributeCommand — input validation", () => {
  it("rejects malformed roomId without an API call", async () => {
    await expect(
      roomsContributeCommand("not-a-uuid", {
        sequence: 1,
        verdict: "APPROVE",
        summary: "ok",
        rawMd: "review",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION", exitCode: 1 });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("rejects missing --sequence", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        verdict: "APPROVE",
        summary: "ok",
        rawMd: "review",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects negative --sequence", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: -1,
        verdict: "APPROVE",
        summary: "ok",
        rawMd: "review",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects body via flags AND --body-file (mutex)", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "APPROVE",
        summary: "ok",
        bodyFile: "/tmp/x",
        rawMd: "review",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects --verdict alone without --summary", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "APPROVE",
        rawMd: "review",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects --summary alone without --verdict", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        summary: "ok",
        rawMd: "review",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects unknown verdict value", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "lgtm",  // not in the enum
        summary: "ok",
        rawMd: "review",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects empty --summary", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "APPROVE",
        summary: "",
        rawMd: "review",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects --summary above 500 chars", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "APPROVE",
        summary: "x".repeat(501),
        rawMd: "review",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects --raw-md AND --raw-md-file (mutex)", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "APPROVE",
        summary: "ok",
        rawMd: "review",
        rawMdFile: "/tmp/x",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects neither --raw-md nor --raw-md-file (required)", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "APPROVE",
        summary: "ok",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects oversized rawMd (>32 KiB)", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "APPROVE",
        summary: "ok",
        rawMd: "X".repeat(32 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("counts UTF-8 bytes (not UTF-16 code units) for the size cap", async () => {
    // 2-byte UTF-8 char × ~17 KiB = ~34 KiB UTF-8 bytes — over the
    // cap. If the cap counted UTF-16 code units (string length) it
    // would be ~17 KiB and pass. This pins the byte-counting choice.
    const twoBytePerChar = "ñ".repeat(17 * 1024);
    expect(twoBytePerChar.length).toBeLessThanOrEqual(32 * 1024); // js length
    expect(Buffer.byteLength(twoBytePerChar, "utf8")).toBeGreaterThan(32 * 1024);
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "APPROVE",
        summary: "ok",
        rawMd: twoBytePerChar,
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });
});

describe("roomsContributeCommand — body building", () => {
  it("builds body from --verdict + --summary when no file supplied", async () => {
    await roomsContributeCommand(VALID_ID, {
      sequence: 5,
      verdict: "REQUEST_CHANGES",
      summary: "needs more tests",
      rawMd: "## Review\n\nDetails here.",
    });
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const call = mockedPost.mock.calls[0][0];
    expect(call.path).toBe(`/api/rooms/${VALID_ID}/contributions`);
    expect(call.body).toEqual({
      sequenceObservedByClient: 5,
      body: { verdict: "REQUEST_CHANGES", summary: "needs more tests" },
      rawMd: "## Review\n\nDetails here.",
    });
  });

  it("loads structured body from --body-file (with findings)", async () => {
    const bodyFile = await makeTmpFile(
      "body.json",
      JSON.stringify({
        verdict: "CONCERNS",
        summary: "two issues found",
        findings: [
          {
            area: "auth",
            severity: "blocker",
            detail: "token leaks in logs",
            code_ref: "src/auth.ts:42",
          },
          { area: "perf", severity: "warning", detail: "N+1 query" },
        ],
        severity_counts: { blocker: 1, warning: 1 },
      }),
    );
    await roomsContributeCommand(VALID_ID, {
      sequence: 9,
      bodyFile,
      rawMd: "review markdown",
    });
    const call = mockedPost.mock.calls[0][0];
    expect(call.body.body).toMatchObject({
      verdict: "CONCERNS",
      summary: "two issues found",
      findings: expect.arrayContaining([
        expect.objectContaining({ area: "auth", severity: "blocker" }),
      ]),
      severity_counts: { blocker: 1, warning: 1 },
    });
  });

  it("rejects --body-file with malformed JSON", async () => {
    const bodyFile = await makeTmpFile("body.json", "{not json");
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        bodyFile,
        rawMd: "x",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("rejects --body-file containing a non-object (array)", async () => {
    const bodyFile = await makeTmpFile("body.json", "[]");
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        bodyFile,
        rawMd: "x",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects --body-file with bad verdict (silent-downgrade trap)", async () => {
    const bodyFile = await makeTmpFile(
      "body.json",
      JSON.stringify({ verdict: "approve", summary: "ok" }), // lowercase
    );
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        bodyFile,
        rawMd: "x",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });

  it("rejects --body-file when path doesn't exist", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        bodyFile: "/no/such/path/that/exists.json",
        rawMd: "x",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });
});

describe("roomsContributeCommand — raw md sources", () => {
  it("reads --raw-md-file from disk", async () => {
    const mdFile = await makeTmpFile("review.md", "# Review\n\nLooks good.");
    await roomsContributeCommand(VALID_ID, {
      sequence: 1,
      verdict: "APPROVE",
      summary: "ok",
      rawMdFile: mdFile,
    });
    expect(mockedPost.mock.calls[0][0].body.rawMd).toBe(
      "# Review\n\nLooks good.",
    );
  });

  it("rejects --raw-md-file when path doesn't exist", async () => {
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 1,
        verdict: "APPROVE",
        summary: "ok",
        rawMdFile: "/no/such/file.md",
      }),
    ).rejects.toMatchObject({ code: "INVALID_OPTION" });
  });
});

describe("roomsContributeCommand — request shape + output", () => {
  it("includes agentId when supplied", async () => {
    await roomsContributeCommand(VALID_ID, {
      sequence: 3,
      verdict: "COMMENT",
      summary: "fyi",
      rawMd: "..",
      agentId: "vercel.123",
    });
    expect(mockedPost.mock.calls[0][0].body.agentId).toBe("vercel.123");
  });

  it("omits agentId when not supplied (server defaults to bearer name)", async () => {
    await roomsContributeCommand(VALID_ID, {
      sequence: 3,
      verdict: "COMMENT",
      summary: "fyi",
      rawMd: "..",
    });
    expect(mockedPost.mock.calls[0][0].body).not.toHaveProperty("agentId");
  });

  it("forwards --token and --api-url to the client", async () => {
    await roomsContributeCommand(VALID_ID, {
      sequence: 1,
      verdict: "APPROVE",
      summary: "ok",
      rawMd: "x",
      token: "tok-abc",
      apiUrl: "https://staging.example",
    });
    const call = mockedPost.mock.calls[0][0];
    expect(call.token).toBe("tok-abc");
    expect(call.apiUrl).toBe("https://staging.example");
  });

  it("emits `{ roomId, sequence }` JSON when --json", async () => {
    mockedPost.mockResolvedValue({ sequence: 42 } as SubmitContributionResponse);
    const logSpy = vi.spyOn(console, "log");
    await roomsContributeCommand(VALID_ID, {
      sequence: 5,
      verdict: "APPROVE",
      summary: "ok",
      rawMd: "x",
      json: true,
    });
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
      roomId: VALID_ID,
      sequence: 42,
    });
  });

  it("emits human one-liner by default with sequence + verdict", async () => {
    mockedPost.mockResolvedValue({ sequence: 42 } as SubmitContributionResponse);
    const logSpy = vi.spyOn(console, "log");
    await roomsContributeCommand(VALID_ID, {
      sequence: 5,
      verdict: "APPROVE",
      summary: "ok",
      rawMd: "x",
    });
    const out = logSpy.mock.calls[0][0] as string;
    expect(out).toContain(`room ${VALID_ID}`);
    expect(out).toContain("sequence 42");
    expect(out).toContain("verdict APPROVE");
  });

  it("propagates server CliError (e.g., status_precondition)", async () => {
    mockedPost.mockRejectedValue(
      new CliError(
        "409 Room status changed (/api/rooms/.../contributions)",
        "status_precondition_failed",
        3,
      ),
    );
    await expect(
      roomsContributeCommand(VALID_ID, {
        sequence: 5,
        verdict: "APPROVE",
        summary: "ok",
        rawMd: "x",
      }),
    ).rejects.toMatchObject({
      code: "status_precondition_failed",
      exitCode: 3,
    });
  });
});
