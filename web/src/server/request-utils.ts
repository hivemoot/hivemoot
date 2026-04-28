export function parseContentLength(header: string | null): number | null {
  if (!header) return null;
  const parsed = Number(header);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

/**
 * Parse a request body as a JSON object.
 *
 * Closes #519 builder R1: the naive pattern
 *
 *   const body = (await request.json()) as MyShape;
 *
 * fails closed on `null`, arrays, and primitives. `JSON.parse("null")`
 * returns `null` (TS-cast bypasses runtime check), then `body.foo`
 * crashes with TypeError instead of returning the intended 400.
 * `JSON.parse("[]")` returns an array, which `typeof === "object"`
 * but has no named fields the handler expects.
 *
 * This helper consolidates the validation:
 *   - JSON parse failure → `{ ok: false, code: "invalid_json" }`
 *   - Parsed value is `null` / array / primitive → `{ ok: false, code: "invalid_body_shape" }`
 *   - Plain object → `{ ok: true, body: value as Record<string, unknown> }`
 *
 * Caller still does its own field-shape validation; this just
 * guarantees a non-null, non-array object to property-access into.
 */
export type ParseJsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: "invalid_json" | "invalid_body_shape"; message: string };

export async function parseJsonBody(
  request: Request,
): Promise<ParseJsonBodyResult> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      code: "invalid_json",
      message: "Request body must be valid JSON.",
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      code: "invalid_body_shape",
      message: "Request body must be a JSON object (got null, array, or primitive).",
    };
  }
  return { ok: true, body: raw as Record<string, unknown> };
}

/**
 * Parse an OPTIONAL JSON object body. Distinct from `parseJsonBody`
 * in that an entirely-absent body (empty text, no `Content-Length`)
 * is treated as `ok` with `body: {}` rather than `invalid_json`.
 *
 * Closes #519 builder R3: the prior `/force-close` heuristic
 * (`content-length === "0"` skip-parse) didn't cover the operator
 * one-liner `curl -X POST .../force-close` — `Content-Length` is
 * absent (not `"0"`), so the handler entered the parse branch,
 * `request.json()` threw "Unexpected end of JSON input", and the
 * route returned 400 instead of defaulting to `force_close`.
 *
 * Reads body as text first, then:
 *   - empty / whitespace-only text → `ok` with `body: {}` (operator
 *     panic-button compat)
 *   - non-empty text that doesn't parse → `invalid_json` (genuine
 *     truncation / malformed payload — fail loud, do NOT default)
 *   - non-empty text that parses but isn't a plain object →
 *     `invalid_body_shape`
 *
 * Use this for endpoints where an empty body is a valid "use defaults"
 * signal (force-close, possibly future internal-trigger endpoints).
 * For endpoints that REQUIRE a body, stick with `parseJsonBody`.
 */
export async function parseOptionalJsonObjectBody(
  request: Request,
): Promise<ParseJsonBodyResult> {
  const text = await request.text();
  if (text.trim() === "") {
    return { ok: true, body: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: "invalid_json",
      message: "Request body must be valid JSON or empty.",
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      code: "invalid_body_shape",
      message: "Request body must be a JSON object (got null, array, or primitive).",
    };
  }
  return { ok: true, body: raw as Record<string, unknown> };
}
