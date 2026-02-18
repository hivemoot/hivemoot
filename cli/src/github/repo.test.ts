import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchRepoPushAccess, resolveRepo } from "./repo.js";

const mockGh = gh as unknown as ReturnType<typeof vi.fn>;

describe("resolveRepo()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("with --repo flag", () => {
    it("parses OWNER/REPO format", async () => {
      const result = await resolveRepo("hivemoot/cli");

      expect(result).toEqual({ owner: "hivemoot", repo: "cli" });
      expect(mockGh).not.toHaveBeenCalled();
    });

    it("throws on invalid format (no slash)", async () => {
      await expect(resolveRepo("invalid")).rejects.toThrow(CliError);
      await expect(resolveRepo("invalid")).rejects.toMatchObject({
        code: "GH_ERROR",
      });
    });

    it("throws on invalid format (empty parts)", async () => {
      await expect(resolveRepo("/repo")).rejects.toThrow(CliError);
      await expect(resolveRepo("owner/")).rejects.toThrow(CliError);
    });

    it("throws on too many slashes", async () => {
      await expect(resolveRepo("a/b/c")).rejects.toThrow(CliError);
    });

    it("throws on invalid characters in owner or repo name", async () => {
      await expect(resolveRepo("owner/../other")).rejects.toThrow(CliError);
      await expect(resolveRepo("ow ner/repo")).rejects.toThrow(CliError);
      await expect(resolveRepo("owner/re po")).rejects.toThrow(CliError);
    });

    it("allows dots, hyphens, underscores in names", async () => {
      const result = await resolveRepo("my-org/my_repo.js");
      expect(result).toEqual({ owner: "my-org", repo: "my_repo.js" });
    });
  });

  describe("auto-detection from git remote", () => {
    it("detects repo when owner is an object with login field", async () => {
      mockGh.mockResolvedValue(
        JSON.stringify({ owner: { login: "hivemoot", id: "MDQ6" }, name: "cli" }),
      );

      const result = await resolveRepo();

      expect(result).toEqual({ owner: "hivemoot", repo: "cli" });
    });

    it("detects repo when owner is a plain string", async () => {
      mockGh.mockResolvedValue(
        JSON.stringify({ owner: "hivemoot", name: "cli" }),
      );

      const result = await resolveRepo();

      expect(result).toEqual({ owner: "hivemoot", repo: "cli" });
      expect(mockGh).toHaveBeenCalledWith([
        "repo",
        "view",
        "--json",
        "owner,name",
      ]);
    });

    it("throws when gh returns malformed JSON", async () => {
      mockGh.mockResolvedValue("not valid json");

      await expect(resolveRepo()).rejects.toThrow(CliError);
      await expect(resolveRepo()).rejects.toMatchObject({
        code: "GH_ERROR",
        message: expect.stringContaining("Failed to parse"),
      });
    });

    it("throws when gh returns JSON missing owner/name fields", async () => {
      mockGh.mockResolvedValue(JSON.stringify({ something: "else" }));

      await expect(resolveRepo()).rejects.toThrow(CliError);
      await expect(resolveRepo()).rejects.toMatchObject({
        code: "NOT_GIT_REPO",
        message: expect.stringContaining("Could not detect"),
      });
    });

    it("throws NOT_GIT_REPO when gh fails with non-CliError", async () => {
      mockGh.mockRejectedValue(new Error("not a git repository"));

      await expect(resolveRepo()).rejects.toThrow(CliError);
      await expect(resolveRepo()).rejects.toMatchObject({
        code: "NOT_GIT_REPO",
        exitCode: 2,
      });
    });

    it("re-throws CliError from gh client (e.g. GH_NOT_FOUND)", async () => {
      mockGh.mockRejectedValue(
        new CliError(
          "gh CLI not found. Install: https://cli.github.com",
          "GH_NOT_FOUND",
          2,
        ),
      );

      await expect(resolveRepo()).rejects.toThrow(CliError);
      await expect(resolveRepo()).rejects.toMatchObject({
        code: "GH_NOT_FOUND",
      });
    });
  });
});

describe("fetchRepoPushAccess()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when permissions.push is true", async () => {
    mockGh.mockResolvedValue(JSON.stringify({ permissions: { push: true } }));

    await expect(fetchRepoPushAccess({ owner: "hivemoot", repo: "cli" })).resolves.toBe(true);
    expect(mockGh).toHaveBeenCalledWith(["api", "/repos/hivemoot/cli"]);
  });

  it("returns false when permissions.push is false", async () => {
    mockGh.mockResolvedValue(JSON.stringify({ permissions: { push: false } }));

    await expect(fetchRepoPushAccess({ owner: "hivemoot", repo: "cli" })).resolves.toBe(false);
  });

  it("returns true when viewer_permission is WRITE", async () => {
    mockGh.mockResolvedValue(JSON.stringify({ viewer_permission: "WRITE" }));

    await expect(fetchRepoPushAccess({ owner: "hivemoot", repo: "cli" })).resolves.toBe(true);
  });

  it("returns true when viewer_permission is MAINTAIN", async () => {
    mockGh.mockResolvedValue(JSON.stringify({ viewer_permission: "MAINTAIN" }));

    await expect(fetchRepoPushAccess({ owner: "hivemoot", repo: "cli" })).resolves.toBe(true);
  });

  it("returns true when viewer_permission is ADMIN", async () => {
    mockGh.mockResolvedValue(JSON.stringify({ viewer_permission: "ADMIN" }));

    await expect(fetchRepoPushAccess({ owner: "hivemoot", repo: "cli" })).resolves.toBe(true);
  });

  it("returns false when viewer_permission is READ", async () => {
    mockGh.mockResolvedValue(JSON.stringify({ viewer_permission: "READ" }));

    await expect(fetchRepoPushAccess({ owner: "hivemoot", repo: "cli" })).resolves.toBe(false);
  });

  it("returns undefined when push permission cannot be inferred", async () => {
    mockGh.mockResolvedValue(JSON.stringify({ name: "cli" }));

    await expect(fetchRepoPushAccess({ owner: "hivemoot", repo: "cli" })).resolves.toBeUndefined();
  });

  it("throws GH_ERROR when gh returns malformed JSON", async () => {
    mockGh.mockResolvedValue("this is not json");

    await expect(fetchRepoPushAccess({ owner: "hivemoot", repo: "cli" })).rejects.toMatchObject({
      code: "GH_ERROR",
      message: "Failed to parse repository permissions from gh CLI response.",
    });
  });
});
