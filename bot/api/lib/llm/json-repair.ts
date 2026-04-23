/**
 * JSON repair helpers for structured LLM output.
 *
 * Several providers (notably Gemini variants) occasionally wrap otherwise
 * valid JSON in markdown fences or prepend non-JSON text (reasoning/preamble),
 * which causes AI SDK object parsing to fail.
 *
 * References:
 * - https://github.com/vercel/ai/issues/5594
 * - https://github.com/vercel/ai/issues/6183
 * - https://github.com/vercel/ai/issues/11450
 * - https://github.com/vercel/ai/issues/4906
 */

import type { RepairTextFunction } from "ai";

const FENCED_JSON_REGEX = /```(?:json)?\s*([\s\S]*?)\s*```/i;

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function extractBalancedJsonSegment(text: string, start: number): string | null {
  const startChar = text[start];
  if (startChar !== "{" && startChar !== "[") {
    return null;
  }

  const endChar = startChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === startChar) {
      depth += 1;
      continue;
    }

    if (ch === endChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1).trim();
      }
    }
  }

  return null;
}

/**
 * Attempt to extract a JSON payload from malformed model text.
 * Returns null when no safe repair candidate is found.
 */
export function extractLikelyJsonPayload(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (isValidJson(trimmed)) {
    return null;
  }

  // Common failure: fenced JSON with optional leading noise/preamble.
  const fencedMatch = trimmed.match(FENCED_JSON_REGEX);
  if (fencedMatch?.[1]) {
    const candidate = fencedMatch[1].trim();
    if (candidate.length > 0 && isValidJson(candidate)) {
      return candidate;
    }
  }

  // Fallback: drop leading prose and keep content from first JSON token.
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const firstJsonStart =
    objectStart === -1
      ? arrayStart
      : arrayStart === -1
        ? objectStart
        : Math.min(objectStart, arrayStart);

  if (firstJsonStart >= 0) {
    const candidate = extractBalancedJsonSegment(trimmed, firstJsonStart);
    if (candidate && isValidJson(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * AI SDK hook for repairing malformed JSON before schema parsing.
 */
export const repairMalformedJsonText: RepairTextFunction = async ({ text, error }) => {
  // TypeValidationError can occur for non-parse reasons (schema mismatch).
  // Keep repairs targeted to parse-like failures to avoid masking real issues.
  const errorMessage = error.message.toLowerCase();
  const isParseLikeError =
    errorMessage.includes("json") ||
    errorMessage.includes("parse") ||
    errorMessage.includes("unexpected token");
  if (!isParseLikeError) {
    return null;
  }

  const repaired = extractLikelyJsonPayload(text);
  if (!repaired || repaired === text) {
    return null;
  }
  return repaired;
};
