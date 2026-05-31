/**
 * /api/model-credentials  (MODEL_AUTH_DESIGN.md Stage 1, §5.1 / §5.3)
 *
 *   POST — create a model credential (requireFresh; validate name/kind/
 *          provider; for api_key live-validate the value before encrypt+store;
 *          atomic cap-check; audit). Never returns the value.
 *   GET  — list credential SUMMARIES (requireFresh:false; NEVER ciphertext).
 *
 * installationId comes ONLY from the authenticated session (via
 * `requireInstallation`) — never from the request body/query. Mutations
 * require a fresh session (step-up gate); reads do not.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { validateProviderKey } from "@/server/provider-validation";
import {
  createModelCredential,
  listModelCredentials,
  isModelCredentialKind,
  isModelCredentialProvider,
  type ModelCredentialKind,
  type ModelCredentialProvider,
} from "@/server/model-credential-store";
import {
  MODEL_CREDENTIAL_ERROR,
  mcError,
  readJsonObject,
  mapModelCredentialError,
} from "@/server/model-credential-routes";

/**
 * Providers `validateProviderKey` can live-probe. `zai` has no validator
 * (provider-validation.ts), so an api_key for it is stored without a live
 * probe — failing closed would block a legitimate Z.AI key. (Documented
 * fallback per the CLAUDE.md "clarify fallback behavior" rule: we accept the
 * key un-probed because there is no probe endpoint; the credential is still
 * GCM-encrypted and provider/kind-validated.)
 */
const LIVE_VALIDATABLE_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "openrouter",
]);

interface CreateBody {
  name?: unknown;
  kind?: unknown;
  provider?: unknown;
  value?: unknown;
  expiresAt?: unknown;
  deliverable?: unknown;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as CreateBody;

  // --- field validation (before any storage / crypto work) ---
  if (typeof body.name !== "string" || body.name.length === 0) {
    return mcError(
      MODEL_CREDENTIAL_ERROR.INVALID_NAME,
      "Missing or invalid 'name'.",
      400,
    );
  }
  if (!isModelCredentialKind(body.kind)) {
    return mcError(
      MODEL_CREDENTIAL_ERROR.INVALID_KIND,
      "Missing or invalid 'kind' (expected 'api_key' or 'oauth_subscription').",
      400,
    );
  }
  if (!isModelCredentialProvider(body.provider)) {
    return mcError(
      MODEL_CREDENTIAL_ERROR.INVALID_PROVIDER,
      "Missing or invalid 'provider'.",
      400,
    );
  }
  if (typeof body.value !== "string" || body.value.length === 0) {
    return mcError(
      MODEL_CREDENTIAL_ERROR.VALIDATION,
      "Missing or invalid 'value'.",
      400,
    );
  }
  if (typeof body.deliverable !== "boolean") {
    return mcError(
      MODEL_CREDENTIAL_ERROR.VALIDATION,
      "Missing or invalid 'deliverable' (boolean).",
      400,
    );
  }
  let expiresAt: string | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (
      typeof body.expiresAt !== "string" ||
      Number.isNaN(new Date(body.expiresAt).getTime())
    ) {
      return mcError(
        MODEL_CREDENTIAL_ERROR.VALIDATION,
        "'expiresAt' must be an ISO 8601 timestamp or null.",
        400,
      );
    }
    expiresAt = body.expiresAt;
  }

  const kind: ModelCredentialKind = body.kind;
  const provider: ModelCredentialProvider = body.provider;
  const value: string = body.value;

  // --- live provider probe for api_key (never logs/echoes the value) ---
  if (kind === "api_key" && LIVE_VALIDATABLE_PROVIDERS.has(provider)) {
    const validation = await validateProviderKey(provider, value);
    if (!validation.valid) {
      return mcError(
        MODEL_CREDENTIAL_ERROR.VALIDATION,
        validation.reason ?? "Provider rejected the API key.",
        400,
      );
    }
  }

  try {
    const summary = await createModelCredential({
      installationId,
      name: body.name,
      kind,
      provider,
      value,
      createdBy: auth.session.userLogin,
      expiresAt,
      deliverable: body.deliverable,
      keyring: auth.keyring,
      keyVersion: auth.activeKeyVersion,
      redis: auth.redis,
      auditContext: { operator: auth.session.userLogin },
    });
    // summary excludes all crypto fields — never returns the value.
    return NextResponse.json(summary, { status: 201 });
  } catch (err) {
    return mapModelCredentialError(err, {
      route: "POST /api/model-credentials",
      installationId,
      name: body.name,
    });
  }
}

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request, { requireFresh: false });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  try {
    const summaries = await listModelCredentials({
      installationId,
      redis: auth.redis,
    });
    // summaries never include ciphertext.
    return NextResponse.json({ credentials: summaries });
  } catch (err) {
    return mapModelCredentialError(err, {
      route: "GET /api/model-credentials",
      installationId,
    });
  }
}
