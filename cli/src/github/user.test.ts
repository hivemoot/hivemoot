import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchCurrentUser } from "./user.js";

const mockGh = gh as unknown as ReturnType<typeof vi.fn>;

describe("fetchCurrentUser()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the login on success", async () => {
    mockGh.mockResolvedValue("alice");

    const result = await fetchCurrentUser();

    expect(result).toBe("alice");
    expect(mockGh).toHaveBeenCalledWith(["api", "user", "--jq", ".login"]);
  });

  it("throws GH_NOT_AUTHENTICATED when login is empty", async () => {
    mockGh.mockResolvedValue("");

    await expect(fetchCurrentUser()).rejects.toThrow(CliError);
    await expect(fetchCurrentUser()).rejects.toMatchObject({
      code: "GH_NOT_AUTHENTICATED",
      exitCode: 2,
      message: expect.stringContaining("Could not determine"),
    });
  });

  it("propagates CliError from gh client", async () => {
    mockGh.mockRejectedValue(
      new CliError("gh CLI not found. Install: https://cli.github.com", "GH_NOT_FOUND", 2),
    );

    await expect(fetchCurrentUser()).rejects.toThrow(CliError);
    await expect(fetchCurrentUser()).rejects.toMatchObject({
      code: "GH_NOT_FOUND",
    });
  });
});
