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
