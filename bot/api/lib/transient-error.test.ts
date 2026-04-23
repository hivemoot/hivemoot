import { describe, it, expect } from "vitest";
import { GraphqlResponseError } from "@octokit/graphql";
import { isTransientError, isAutoMergeNotEnabledError, TRANSIENT_NETWORK_CODES } from "./transient-error.js";

describe("isTransientError", () => {
  describe("network codes", () => {
    it.each([...TRANSIENT_NETWORK_CODES])("should return true for %s", (code) => {
      expect(isTransientError({ code })).toBe(true);
    });

    it("should return false for an unknown network code", () => {
      expect(isTransientError({ code: "EUNKNOWN" })).toBe(false);
    });
  });

  describe("HTTP status codes", () => {
    it("should return true for HTTP 429 (rate limit)", () => {
      expect(isTransientError({ status: 429 })).toBe(true);
    });

    it("should return true for HTTP 500 (internal server error)", () => {
      expect(isTransientError({ status: 500 })).toBe(true);
    });

    it("should return true for HTTP 502 (bad gateway)", () => {
      expect(isTransientError({ status: 502 })).toBe(true);
    });

    it("should return true for HTTP 503 (service unavailable)", () => {
      expect(isTransientError({ status: 503 })).toBe(true);
    });

    it("should return true for HTTP 504 (gateway timeout)", () => {
      expect(isTransientError({ status: 504 })).toBe(true);
    });

    it("should return false for HTTP 400 (bad request)", () => {
      expect(isTransientError({ status: 400 })).toBe(false);
    });

    it("should return false for HTTP 401 (unauthorized)", () => {
      expect(isTransientError({ status: 401 })).toBe(false);
    });

    it("should return false for HTTP 403 (forbidden)", () => {
      expect(isTransientError({ status: 403 })).toBe(false);
    });

    it("should return false for HTTP 404 (not found)", () => {
      expect(isTransientError({ status: 404 })).toBe(false);
    });

    it("should return false for HTTP 422 (unprocessable entity)", () => {
      expect(isTransientError({ status: 422 })).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should return false for a plain Error without status or code", () => {
      expect(isTransientError(new Error("Something broke"))).toBe(false);
    });

    it("should return false for null", () => {
      expect(isTransientError(null)).toBe(false);
    });

    it("should return false for a string", () => {
      expect(isTransientError("error")).toBe(false);
    });

    it("should return false for an empty object", () => {
      expect(isTransientError({})).toBe(false);
    });

    it("should return false when code is a non-string value", () => {
      expect(isTransientError({ code: 42 })).toBe(false);
    });
  });
});

describe("isAutoMergeNotEnabledError", () => {
  function makeNotEnabledError(): GraphqlResponseError<null> {
    return new GraphqlResponseError(
      { url: "https://api.github.com/graphql" },
      {},
      {
        data: null,
        errors: [{ message: "Pull request Auto merge is not enabled.", type: "UNPROCESSABLE" }],
      }
    );
  }

  it("returns true for a GraphqlResponseError with UNPROCESSABLE type and 'not enabled' message", () => {
    expect(isAutoMergeNotEnabledError(makeNotEnabledError())).toBe(true);
  });

  it("returns false for a plain Error with the old string sentinel", () => {
    // The old string-match check would have incorrectly passed this — the real GitHub
    // error is a GraphqlResponseError, not a plain Error.
    expect(isAutoMergeNotEnabledError(new Error("PullRequestAutoMergeNotEnabled"))).toBe(false);
  });

  it("returns false for a GraphqlResponseError with a different type", () => {
    const err = new GraphqlResponseError(
      { url: "https://api.github.com/graphql" },
      {},
      { data: null, errors: [{ message: "Not Found", type: "NOT_FOUND" }] }
    );
    expect(isAutoMergeNotEnabledError(err)).toBe(false);
  });

  it("returns false for a GraphqlResponseError with UNPROCESSABLE type but unrelated message", () => {
    const err = new GraphqlResponseError(
      { url: "https://api.github.com/graphql" },
      {},
      { data: null, errors: [{ message: "Branch protection required.", type: "UNPROCESSABLE" }] }
    );
    expect(isAutoMergeNotEnabledError(err)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAutoMergeNotEnabledError(null)).toBe(false);
  });

  it("returns false for a plain object without name", () => {
    expect(isAutoMergeNotEnabledError({ message: "PullRequestAutoMergeNotEnabled" })).toBe(false);
  });

  it("returns true for a cross-version instance (duck-typed, not instanceof)", () => {
    // Simulates GraphqlResponseError thrown by octokit's bundled @octokit/graphql 9.x
    // when the root install is 7.x — instanceof would fail, but duck-typing works.
    const foreignError = Object.assign(new Error("Request failed"), {
      name: "GraphqlResponseError",
      errors: [{ message: "Pull request Auto merge is not enabled.", type: "UNPROCESSABLE" }],
    });
    expect(isAutoMergeNotEnabledError(foreignError)).toBe(true);
  });

  it("returns false for a cross-version instance with a non-matching error type", () => {
    const foreignError = Object.assign(new Error("Request failed"), {
      name: "GraphqlResponseError",
      errors: [{ message: "Not Found", type: "NOT_FOUND" }],
    });
    expect(isAutoMergeNotEnabledError(foreignError)).toBe(false);
  });
});
