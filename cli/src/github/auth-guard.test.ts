import { describe, it, expect, afterEach } from "vitest";
import { CliError } from "../config/types.js";
import { rejectAppInstallationToken } from "./auth-guard.js";

describe("rejectAppInstallationToken", () => {
  // Restore env vars after each test so we don't leak between cases
  // (or with whatever the host environment had set).
  const origGhToken = process.env.GH_TOKEN;
  const origGithubToken = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (origGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = origGhToken;
    if (origGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = origGithubToken;
  });

  it("rejects ghs_-prefixed GH_TOKEN with GH_APP_TOKEN_UNSUPPORTED", () => {
    process.env.GH_TOKEN = "ghs_fake_installation_token_xyz";
    delete process.env.GITHUB_TOKEN;

    expect(() => rejectAppInstallationToken("watch")).toThrowError(
      expect.objectContaining({ code: "GH_APP_TOKEN_UNSUPPORTED" }),
    );
  });

  it("rejects ghs_-prefixed GITHUB_TOKEN when GH_TOKEN is unset", () => {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "ghs_another_one";

    expect(() => rejectAppInstallationToken("ack")).toThrowError(
      expect.objectContaining({ code: "GH_APP_TOKEN_UNSUPPORTED" }),
    );
  });

  it("error message names the command and points at watch_new_prs", () => {
    process.env.GH_TOKEN = "ghs_x";
    delete process.env.GITHUB_TOKEN;

    let captured: CliError | undefined;
    try {
      rejectAppInstallationToken("notifications-pull");
    } catch (err) {
      captured = err as CliError;
    }
    expect(captured).toBeDefined();
    expect(captured?.message).toMatch(/hivemoot notifications-pull/);
    expect(captured?.message).toMatch(/watch_new_prs/);
    expect(captured?.message).toMatch(/App installation tokens/);
    expect(captured?.exitCode).toBe(2);
  });

  it("does NOT reject a ghp_-prefixed PAT (legacy user PAT)", () => {
    process.env.GH_TOKEN = "ghp_classic_pat";
    delete process.env.GITHUB_TOKEN;
    expect(() => rejectAppInstallationToken("watch")).not.toThrow();
  });

  it("does NOT reject a gho_-prefixed user-to-server OAuth token", () => {
    process.env.GH_TOKEN = "gho_oauth_user_to_server";
    delete process.env.GITHUB_TOKEN;
    expect(() => rejectAppInstallationToken("watch")).not.toThrow();
  });

  it("does NOT reject when no token env is set (downstream error handles it)", () => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    // Empty token string doesn't match ghs_ prefix → passes guard.
    // The downstream gh call will fail with auth error — which is the
    // correct behavior (operator forgot to set the token).
    expect(() => rejectAppInstallationToken("watch")).not.toThrow();
  });

  it("prefers GH_TOKEN over GITHUB_TOKEN when both are set", () => {
    // Mirrors gh CLI's own precedence — GH_TOKEN wins. The guard
    // should check the SAME token gh would actually use.
    process.env.GH_TOKEN = "ghp_legacy_pat";
    process.env.GITHUB_TOKEN = "ghs_app_installation";
    expect(() => rejectAppInstallationToken("watch")).not.toThrow();
  });
});
