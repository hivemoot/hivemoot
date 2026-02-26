import { describe, expect, it } from "vitest";
import { getErrorMessage, normalizeErrorCode } from "./page";

describe("setup error page code normalization", () => {
  it("keeps known error codes", () => {
    expect(normalizeErrorCode("oauth_state_store_failed")).toBe("oauth_state_store_failed");
    expect(normalizeErrorCode("oauth_state_read_failed")).toBe("oauth_state_read_failed");
    expect(normalizeErrorCode("setup_session_create_failed")).toBe("setup_session_create_failed");
    expect(normalizeErrorCode("server_misconfiguration")).toBe("server_misconfiguration");
  });

  it("falls back to server_error for unknown or missing codes", () => {
    expect(normalizeErrorCode(undefined)).toBe("server_error");
    expect(normalizeErrorCode("unknown_code")).toBe("server_error");
  });

  it("maps normalized codes to stable user-facing messages", () => {
    const message = getErrorMessage(normalizeErrorCode("totally_unknown"));
    expect(message).toContain("Something went wrong");
  });
});
