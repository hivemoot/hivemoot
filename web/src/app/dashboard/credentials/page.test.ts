import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((target: string) => {
    // mirror Next's behavior: throw a sentinel so the function never
    // reaches its `: never` return
    throw new Error(`__redirect__:${target}`);
  }),
}));

import LegacyCredentialsRedirect from "./page";

describe("LegacyCredentialsRedirect (PR 6)", () => {
  it("redirects to /dashboard/settings/byok (the new BYOK location)", () => {
    expect(() => LegacyCredentialsRedirect()).toThrowError(
      "__redirect__:/dashboard/settings/byok",
    );
  });
});
