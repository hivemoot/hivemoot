import { describe, expect, it } from "vitest";

import { extractLikelyJsonPayload, repairMalformedJsonText } from "./json-repair.js";

describe("extractLikelyJsonPayload", () => {
  it("extracts JSON from fenced blocks", () => {
    const text = "```json\n{\"sentiment\":\"positive\"}\n```";
    expect(extractLikelyJsonPayload(text)).toBe("{\"sentiment\":\"positive\"}");
  });

  it("extracts fenced JSON when prefixed with noise", () => {
    const text = "ny\n```json\n{\"ok\":true}\n```";
    expect(extractLikelyJsonPayload(text)).toBe("{\"ok\":true}");
  });

  it("extracts payload from first JSON token when prose is prepended", () => {
    const text = "My immediate task is to respond.\n{\"color\":\"blue\"}";
    expect(extractLikelyJsonPayload(text)).toBe("{\"color\":\"blue\"}");
  });

  it("extracts balanced JSON when trailing commentary exists", () => {
    const text = "Here is the result: {\"subject\":\"Fix bug\"} and some trailing text";
    expect(extractLikelyJsonPayload(text)).toBe("{\"subject\":\"Fix bug\"}");
  });

  it("extracts balanced JSON when content starts with JSON and has trailing text", () => {
    const text = "{\"subject\":\"Fix bug\"} and some trailing text";
    expect(extractLikelyJsonPayload(text)).toBe("{\"subject\":\"Fix bug\"}");
  });

  it("returns null when no repair candidate exists", () => {
    expect(extractLikelyJsonPayload("plain text without json")).toBeNull();
  });

  it("returns null for already-plain JSON (no repair needed)", () => {
    expect(extractLikelyJsonPayload("{\"already\":\"json\"}")).toBeNull();
  });

  it("extracts JSON containing braces inside string values", () => {
    const text = "Preamble {\"subject\":\"Fix {bug} in parser\",\"body\":\"Use obj[key] syntax\"}";
    expect(extractLikelyJsonPayload(text)).toBe(
      "{\"subject\":\"Fix {bug} in parser\",\"body\":\"Use obj[key] syntax\"}"
    );
  });

  it("extracts JSON with escaped quotes in string values", () => {
    const text = "Here: {\"subject\":\"Fix \\\"quoted\\\" term\",\"body\":\"Details\"}";
    expect(extractLikelyJsonPayload(text)).toBe(
      "{\"subject\":\"Fix \\\"quoted\\\" term\",\"body\":\"Details\"}"
    );
  });

  it("returns null for truncated JSON without closing brace", () => {
    const text = "Preamble: {\"subject\":\"Fix bug\",\"body\":\"Still writing...";
    expect(extractLikelyJsonPayload(text)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractLikelyJsonPayload("")).toBeNull();
  });
});

describe("repairMalformedJsonText", () => {
  it("returns repaired payload when recoverable", async () => {
    const repaired = await repairMalformedJsonText({
      text: "```json\n{\"value\":1}\n```",
      error: { message: "JSON parsing failed" } as never,
    });
    expect(repaired).toBe("{\"value\":1}");
  });

  it("returns null when text should not be modified", async () => {
    const repaired = await repairMalformedJsonText({
      text: "{\"already\":\"json\"}",
      error: { message: "JSON parsing failed" } as never,
    });
    expect(repaired).toBeNull();
  });

  it("returns null for non-parse errors", async () => {
    const repaired = await repairMalformedJsonText({
      text: "```json\n{\"value\":1}\n```",
      error: { message: "schema validation failed" } as never,
    });
    expect(repaired).toBeNull();
  });
});
