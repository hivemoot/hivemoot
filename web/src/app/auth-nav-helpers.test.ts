import { describe, it, expect } from "vitest";
import {
  parseSessionStatus,
  resolveNavState,
  LOGGED_OUT_STATUS,
} from "./auth-nav-helpers";

describe("parseSessionStatus", () => {
  it("parses an authenticated payload", () => {
    expect(
      parseSessionStatus({ authenticated: true, login: "alice", hasInstallation: true }),
    ).toEqual({ authenticated: true, login: "alice", hasInstallation: true });
  });

  it("treats authenticated:false as logged out", () => {
    expect(parseSessionStatus({ authenticated: false, login: "alice" })).toEqual(
      LOGGED_OUT_STATUS,
    );
  });

  it.each([null, undefined, "nope", 42, [], { login: "alice" }])(
    "treats malformed payload %p as logged out",
    (input) => {
      expect(parseSessionStatus(input)).toEqual(LOGGED_OUT_STATUS);
    },
  );

  it("defaults login to null and hasInstallation to false when absent/invalid", () => {
    expect(parseSessionStatus({ authenticated: true })).toEqual({
      authenticated: true,
      login: null,
      hasInstallation: false,
    });
    expect(parseSessionStatus({ authenticated: true, login: 5, hasInstallation: "yes" })).toEqual({
      authenticated: true,
      login: null,
      hasInstallation: false,
    });
  });
});

describe("resolveNavState", () => {
  const base = {
    loading: false,
    authenticated: false,
    login: null as string | null,
    hasInstallation: false,
    remembered: null as string | null,
  };

  it("returns loading while the probe is in flight (regardless of other inputs)", () => {
    expect(resolveNavState({ ...base, loading: true, authenticated: true, login: "alice" })).toEqual({
      kind: "loading",
    });
  });

  it("returns authenticated for a valid session", () => {
    expect(
      resolveNavState({ ...base, authenticated: true, login: "alice", hasInstallation: true }),
    ).toEqual({ kind: "authenticated", login: "alice", hasInstallation: true });
  });

  it("authenticated wins over a remembered hint", () => {
    const state = resolveNavState({
      ...base,
      authenticated: true,
      login: "alice",
      remembered: "bob",
    });
    expect(state.kind).toBe("authenticated");
  });

  it("returns remembered when signed out but a last login is known", () => {
    expect(resolveNavState({ ...base, remembered: "bob" })).toEqual({
      kind: "remembered",
      login: "bob",
    });
  });

  it("returns anonymous when signed out with no remembered login", () => {
    expect(resolveNavState(base)).toEqual({ kind: "anonymous" });
  });
});
