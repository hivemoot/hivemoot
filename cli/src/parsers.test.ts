import { describe, it, expect } from "vitest";
import { InvalidArgumentError } from "commander";
import { parseLimit, parseNonNegativeInt } from "./parsers.js";

describe("parseNonNegativeInt", () => {
  it("accepts 0 (cursor reset)", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
  });

  it("accepts plain integers", () => {
    expect(parseNonNegativeInt("1")).toBe(1);
    expect(parseNonNegativeInt("42")).toBe(42);
    expect(parseNonNegativeInt("9999")).toBe(9999);
  });

  // ── Regression matrix for builder R1 on #563:
  //    parseInt() silently coerces these to 1, hiding user typos as
  //    network errors when the value reaches the server-side
  //    sequenceObservedByClient cursor.

  it("rejects decimal values (1.5 → silently 1 with parseInt)", () => {
    expect(() => parseNonNegativeInt("1.5")).toThrow(InvalidArgumentError);
  });

  it("rejects trailing alpha (1abc → silently 1 with parseInt)", () => {
    expect(() => parseNonNegativeInt("1abc")).toThrow(InvalidArgumentError);
  });

  it("rejects exponent notation (1e3 → silently 1 with parseInt)", () => {
    expect(() => parseNonNegativeInt("1e3")).toThrow(InvalidArgumentError);
  });

  it("rejects negative values", () => {
    expect(() => parseNonNegativeInt("-1")).toThrow(InvalidArgumentError);
  });

  it("rejects leading + sign", () => {
    expect(() => parseNonNegativeInt("+1")).toThrow(InvalidArgumentError);
  });

  it("rejects leading whitespace", () => {
    expect(() => parseNonNegativeInt(" 1")).toThrow(InvalidArgumentError);
  });

  it("rejects trailing whitespace", () => {
    expect(() => parseNonNegativeInt("1 ")).toThrow(InvalidArgumentError);
  });

  it("rejects empty string", () => {
    expect(() => parseNonNegativeInt("")).toThrow(InvalidArgumentError);
  });

  it("rejects bare 'NaN' / 'Infinity'", () => {
    expect(() => parseNonNegativeInt("NaN")).toThrow(InvalidArgumentError);
    expect(() => parseNonNegativeInt("Infinity")).toThrow(InvalidArgumentError);
  });

  it("rejects values above Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 is unsafe; some digits past that are also unsafe.
    expect(() => parseNonNegativeInt("9007199254740993")).toThrow(
      InvalidArgumentError,
    );
  });

  it("accepts Number.MAX_SAFE_INTEGER (2^53 - 1)", () => {
    expect(parseNonNegativeInt("9007199254740991")).toBe(9007199254740991);
  });
});

describe("parseLimit", () => {
  it("accepts plain positive integers", () => {
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("200")).toBe(200);
  });

  it("rejects 0 (must be positive)", () => {
    expect(() => parseLimit("0")).toThrow(InvalidArgumentError);
  });

  // Same regression matrix as above — parseLimit had identical
  // parseInt-coercion semantics before this fix.

  it("rejects decimals (1.5 → silently 1 with parseInt)", () => {
    expect(() => parseLimit("1.5")).toThrow(InvalidArgumentError);
  });

  it("rejects trailing alpha (5abc → silently 5 with parseInt)", () => {
    expect(() => parseLimit("5abc")).toThrow(InvalidArgumentError);
  });

  it("rejects exponent notation", () => {
    expect(() => parseLimit("1e2")).toThrow(InvalidArgumentError);
  });

  it("rejects negatives", () => {
    expect(() => parseLimit("-5")).toThrow(InvalidArgumentError);
  });

  it("rejects leading whitespace / sign", () => {
    expect(() => parseLimit(" 5")).toThrow(InvalidArgumentError);
    expect(() => parseLimit("+5")).toThrow(InvalidArgumentError);
  });

  it("rejects empty string", () => {
    expect(() => parseLimit("")).toThrow(InvalidArgumentError);
  });
});
