import { describe, it, expect } from "vitest";
import { getCookie } from "./cookies";

describe("getCookie", () => {
  it("returns null when cookie string is empty", () => {
    expect(getCookie("foo", "")).toBeNull();
  });

  it("returns null when cookie is not present", () => {
    expect(getCookie("foo", "other=value")).toBeNull();
  });

  it("reads a simple cookie value", () => {
    expect(getCookie("foo", "foo=bar")).toBe("bar");
  });

  it("reads a cookie when multiple cookies are present", () => {
    expect(getCookie("foo", "first=one; foo=bar; last=three")).toBe("bar");
  });

  it("decodes percent-encoded values", () => {
    expect(getCookie("foo", "foo=hello%20world")).toBe("hello world");
  });

  it("does not partial-match longer cookie names", () => {
    expect(getCookie("foo", "foobar=baz")).toBeNull();
  });

  it("returns null and does not throw when decoding fails", () => {
    expect(getCookie("foo", "foo=%E0%A4%A")).toBeNull(); // invalid UTF-8 percent sequence
  });
});
