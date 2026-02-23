// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { getCookie } from "./cookies";

describe("getCookie", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockCookies(value: string) {
    vi.spyOn(document, "cookie", "get").mockReturnValue(value);
  }

  it("returns null when cookie string is empty", () => {
    mockCookies("");
    expect(getCookie("foo")).toBeNull();
  });

  it("returns null when cookie is not present", () => {
    mockCookies("other=value");
    expect(getCookie("foo")).toBeNull();
  });

  it("reads a simple cookie value", () => {
    mockCookies("foo=bar");
    expect(getCookie("foo")).toBe("bar");
  });

  it("reads a cookie when multiple cookies are present", () => {
    mockCookies("first=one; foo=bar; last=three");
    expect(getCookie("foo")).toBe("bar");
  });

  it("decodes percent-encoded values", () => {
    mockCookies("foo=hello%20world");
    expect(getCookie("foo")).toBe("hello world");
  });

  it("does not partial-match longer cookie names", () => {
    mockCookies("foobar=baz");
    expect(getCookie("foo")).toBeNull();
  });

  it("returns null and does not throw when decoding fails", () => {
    mockCookies("foo=%E0%A4%A"); // invalid UTF-8 percent sequence
    expect(getCookie("foo")).toBeNull();
  });
});
