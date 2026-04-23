import { describe, it, expect } from "vitest";
import { GITHUB_LOGIN_RE } from "./cookies";

describe("GITHUB_LOGIN_RE", () => {
  const valid = [
    "a",
    "A",
    "0",
    "octocat",
    "my-user",
    "a0",
    "a-b",
    "a".repeat(1) + "-".repeat(37) + "z", // 39 chars (max)
    "abc123",
    "A-B-C",
  ];

  const invalid = [
    "",
    "-",
    "-foo",
    "foo-",
    "-foo-",
    "a".repeat(40),            // 40 chars (exceeds GitHub limit)
    "foo bar",
    "foo/bar",
    "<script>alert(1)</script>",
    "foo;bar",
    "user\nname",
    "../../etc/passwd",
    "a".repeat(41),
  ];

  it.each(valid)("accepts valid GitHub login: %s", (login) => {
    expect(GITHUB_LOGIN_RE.test(login)).toBe(true);
  });

  it.each(invalid)("rejects invalid input: %s", (input) => {
    expect(GITHUB_LOGIN_RE.test(input)).toBe(false);
  });
});
