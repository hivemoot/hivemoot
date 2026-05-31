/**
 * Shared helpers for the model-credential route handlers under
 * `/api/model-credentials/*` (MODEL_AUTH_DESIGN.md Stage 1).
 *
 * Mirrors `agent-token-v1-routes.ts`: a self-contained error vocabulary +
 * `mcError` helper (structured `{ code, message, ...details }` JSON, never an
 * internal stack/secret) and a storage-error → HTTP-status mapper so each
 * route's catch block is one line. Deliberately does NOT reuse `byok-error.ts`
 * — this is a distinct subsystem with its own stable codes.
 */

import { NextResponse } from "next/server";
import { LockTimeoutError } from "@hivemoot/war-room/redis-lock";
import { CapabilityValidationError } from "@/server/agent-token-capabilities";
import {
  ModelCredentialNotFoundError,
  NameTakenError,
  LimitReachedError,
  InvalidKindError,
  InvalidProviderError,
} from "@/server/model-credential-store";

/**
 * Stable wire-error codes for the model-credential endpoints. Distinct from
 * BYOK / agent-token codes. The dashboard branches on these.
 */
export const MODEL_CREDENTIAL_ERROR = {
  INVALID_BODY: "invalid_body",
  INVALID_NAME: "invalid_name",
  INVALID_KIND: "invalid_kind",
  INVALID_PROVIDER: "invalid_provider",
  VALIDATION: "validation",
  NOT_FOUND: "not_found",
  NAME_TAKEN: "name_taken",
  LIMIT_REACHED: "limit_reached",
  RATE_LIMITED: "rate_limited",
  REVOKED: "revoked",
  SERVER_ERROR: "server_error",
} as const;

export type ModelCredentialErrorCode =
  (typeof MODEL_CREDENTIAL_ERROR)[keyof typeof MODEL_CREDENTIAL_ERROR];

export function mcError(
  code: ModelCredentialErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ code, message, ...(details ?? {}) }, { status });
}

export type ReadJsonObjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

/**
 * Parse a JSON request body that MUST be a non-array object. Empty body →
 * empty object. Bad JSON / non-object → structured 400 so the handler can
 * early-return. Mirrors `agent-token-v1-routes.readJsonObject`.
 */
export async function readJsonObject(
  request: Request,
): Promise<ReadJsonObjectResult> {
  if (request.body === null) return { ok: true, body: {} };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: mcError(
        MODEL_CREDENTIAL_ERROR.INVALID_BODY,
        "Request body must be valid JSON.",
        400,
      ),
    };
  }
  if (body == null) return { ok: true, body: {} };
  if (typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: mcError(
        MODEL_CREDENTIAL_ERROR.INVALID_BODY,
        "Request body must be a JSON object.",
        400,
      ),
    };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * Catch-all storage error → HTTP response mapper. Each route's catch block
 * delegates here so the mapping is consistent.
 *
 *   - NameTakenError                → 409 name_taken
 *   - ModelCredentialNotFoundError  → 404 not_found  (same for "not yours")
 *   - LimitReachedError             → 422 limit_reached
 *   - InvalidKindError              → 400 invalid_kind
 *   - InvalidProviderError          → 400 invalid_provider
 *   - CapabilityValidationError     → 400 invalid_name (reused NAME_REGEX)
 *   - LockTimeoutError              → 503 rate_limited (concurrent op)
 *   - anything else                 → 500 server_error (logged, opaque)
 *
 * Safe-by-default: never echoes a raw unexpected-error message to the client
 * (could leak internal state); the actual error is logged for ops.
 */
export function mapModelCredentialError(
  err: unknown,
  context: { route: string; installationId: string; name?: string },
): NextResponse {
  if (err instanceof NameTakenError) {
    return mcError(
      MODEL_CREDENTIAL_ERROR.NAME_TAKEN,
      err.message,
      409,
      context.name ? { name: context.name } : undefined,
    );
  }
  if (err instanceof ModelCredentialNotFoundError) {
    return mcError(
      MODEL_CREDENTIAL_ERROR.NOT_FOUND,
      err.message,
      404,
      context.name ? { name: context.name } : undefined,
    );
  }
  if (err instanceof LimitReachedError) {
    return mcError(MODEL_CREDENTIAL_ERROR.LIMIT_REACHED, err.message, 422);
  }
  if (err instanceof InvalidKindError) {
    return mcError(MODEL_CREDENTIAL_ERROR.INVALID_KIND, err.message, 400);
  }
  if (err instanceof InvalidProviderError) {
    return mcError(MODEL_CREDENTIAL_ERROR.INVALID_PROVIDER, err.message, 400);
  }
  if (err instanceof CapabilityValidationError) {
    return mcError(MODEL_CREDENTIAL_ERROR.INVALID_NAME, err.message, 400, {
      field: err.field,
      value: err.value,
    });
  }
  if (err instanceof LockTimeoutError) {
    return mcError(
      MODEL_CREDENTIAL_ERROR.RATE_LIMITED,
      "Another credential operation is in progress for this name. Retry in a moment.",
      503,
    );
  }
  console.error("[model-credentials] unexpected error", {
    route: context.route,
    installationId: context.installationId,
    name: context.name,
    error: err,
  });
  return mcError(
    MODEL_CREDENTIAL_ERROR.SERVER_ERROR,
    "Internal server error.",
    500,
  );
}
