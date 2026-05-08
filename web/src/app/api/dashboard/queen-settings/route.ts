/**
 * GET  /api/dashboard/queen-settings — read the operator's
 *   per-installation queen settings (queen_mode + optional override).
 * POST /api/dashboard/queen-settings — atomically update them under
 *   the per-installation flip-lock (G12). Mutating route: requires
 *   a fresh BYOK session (15-min window).
 *
 * Response shape (both methods):
 *   { queen_mode: "cloud" | "local",
 *     queen_prompt_override: string | null,
 *     installation_id: string }
 *
 * POST body:
 *   { queen_mode: "cloud" | "local",
 *     queen_prompt_override?: string | null }
 *   - omit `queen_prompt_override` to leave the override unchanged
 *   - pass `null` to delete the override
 *   - pass a string to set/replace it
 *
 * Errors:
 *   - 400 invalid_body — malformed POST input
 *   - 401 not_authenticated — missing / expired BYOK session
 *   - 403 fresh_session_required (POST) — session older than 15 min
 *   - 403 no_installation — session has no linked installation
 *   - 409 mode_flip_blocked — PR 2 will surface in-flight rooms here
 *   - 500 storage_failure
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import {
  getQueenSettings,
  setQueenSettings,
  type QueenMode,
  QUEEN_MODE_VALUES,
} from "@/server/queen-settings-store";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const installationId = auth.session.installationId;
  if (installationId === null) {
    return NextResponse.json(
      { code: "no_installation", message: "Session has no linked GitHub installation." },
      { status: 403 },
    );
  }

  try {
    const settings = await getQueenSettings(String(installationId), auth.redis);
    return NextResponse.json({
      installation_id: String(installationId),
      queen_mode: settings.queen_mode,
      queen_prompt_override: settings.queen_prompt_override,
    });
  } catch (error) {
    console.error("[dashboard.queen-settings] Failed to read settings", {
      installationId,
      error,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to load queen settings." },
      { status: 500 },
    );
  }
}

interface PostBody {
  queen_mode: QueenMode;
  queen_prompt_override?: string | null;
}

function isQueenMode(value: unknown): value is QueenMode {
  return typeof value === "string" && (QUEEN_MODE_VALUES as readonly string[]).includes(value);
}

function parseBody(raw: unknown): { ok: true; body: PostBody } | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, message: "Body must be a JSON object." };
  }
  const obj = raw as Record<string, unknown>;
  if (!isQueenMode(obj.queen_mode)) {
    return { ok: false, message: "queen_mode must be 'cloud' or 'local'." };
  }
  if (
    obj.queen_prompt_override !== undefined &&
    obj.queen_prompt_override !== null &&
    typeof obj.queen_prompt_override !== "string"
  ) {
    return {
      ok: false,
      message: "queen_prompt_override must be a string, null, or omitted.",
    };
  }
  return {
    ok: true,
    body: {
      queen_mode: obj.queen_mode,
      queen_prompt_override:
        obj.queen_prompt_override === undefined
          ? undefined
          : (obj.queen_prompt_override as string | null),
    },
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  const installationId = auth.session.installationId;
  if (installationId === null) {
    return NextResponse.json(
      { code: "no_installation", message: "Session has no linked GitHub installation." },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { code: "invalid_body", message: "Body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = parseBody(raw);
  if (!parsed.ok) {
    return NextResponse.json(
      { code: "invalid_body", message: parsed.message },
      { status: 400 },
    );
  }

  try {
    const result = await setQueenSettings({
      installationId: String(installationId),
      redis: auth.redis,
      next: parsed.body,
      // PR 2 plugs in the D9/G37 in-flight precheck here.
      precheck: undefined,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          code: "mode_flip_blocked",
          message: "Mode flip blocked by in-flight work.",
          blocked: result.blocked,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      installation_id: String(installationId),
      queen_mode: result.current.queen_mode,
      queen_prompt_override: result.current.queen_prompt_override,
    });
  } catch (error) {
    console.error("[dashboard.queen-settings] Failed to update settings", {
      installationId,
      error,
    });
    return NextResponse.json(
      { code: "storage_failure", message: "Failed to update queen settings." },
      { status: 500 },
    );
  }
}
