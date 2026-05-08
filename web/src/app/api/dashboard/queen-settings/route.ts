/**
 * GET  /api/dashboard/queen-settings — read the operator's
 *   per-installation queen settings (queen_mode + optional override).
 * POST /api/dashboard/queen-settings — update settings under the
 *   per-installation flip-lock (G12 — serialized writes, NOT
 *   atomic against in-flight queen-tick claims; see the store
 *   docblock at queen-settings-store.ts for the precise semantics).
 *   Mutating route: requires a fresh BYOK session (15-min window).
 *
 * Response shape (both methods):
 *   { queen_mode: "cloud" | "local",
 *     queen_prompt_override: string | null,
 *     installation_id: string }
 *
 * POST body:
 *   { queen_mode: "cloud" | "local",
 *     queen_prompt_override?: null }   ← non-null rejected in PR 1.
 *                                         The D12 structured-YAML
 *                                         schema lands in PR 4.
 *   - omit `queen_prompt_override` to leave the override unchanged
 *   - pass `null` (or `""`) to delete the override
 *   - pass a string → 400 invalid_body until PR 4
 *
 * Errors:
 *   - 400 invalid_body — malformed POST input OR non-null override (PR 1 only)
 *   - 401 not_authenticated — missing / expired BYOK session
 *   - 403 fresh_session_required (POST) — session older than 15 min
 *   - 403 no_installation — session has no linked installation
 *   - 409 mode_flip_blocked — PR 2 surfaces in-flight rooms / tick lock
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
import { checkInFlightForFlip } from "@/server/queen-mode-flip-precheck";

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

/**
 * Maximum bytes for `queen_prompt_override`. Kept as a constant
 * because PR 4 (when the D12 structured-YAML parser lands) will
 * reuse the same byte cap on the validated payload — bounds the
 * storage write surface either way.
 *
 * **In PR 1, non-null overrides are rejected outright** (B1 builder
 * pass-2). D12 is explicit that the override must be a structured
 * config (`merge_conventions`, `additional_blockers`); shipping a
 * free-form-string write surface now would lock in the wrong
 * stored shape and require a migration when PR 4's schema lands.
 * Until PR 4, only `null` (clear) and `undefined` (leave unchanged)
 * are accepted on `queen_prompt_override`.
 */
export const QUEEN_PROMPT_OVERRIDE_MAX_BYTES = 16 * 1024;

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
  // PR 1 only accepts:
  //   - undefined → leave the existing override untouched
  //   - null      → delete the override (clear)
  //   - "" (empty string) → normalize to null (B3 — guard pass-1
  //     round-trip symmetry; the store's reader coerces "" to null
  //     anyway, so we honor that contract at the boundary)
  // Non-empty strings are REJECTED until PR 4's D12 schema parser
  // ships (B1 — builder pass-2). Locking the stored shape down now
  // prevents PR 4 from needing a Redis migration.
  let override: string | null | undefined;
  if (obj.queen_prompt_override === undefined) {
    override = undefined;
  } else if (obj.queen_prompt_override === null) {
    override = null;
  } else {
    const s = obj.queen_prompt_override as string;
    if (s.length === 0) {
      override = null;
    } else {
      return {
        ok: false,
        message:
          "queen_prompt_override must be null or omitted in PR 1. " +
          "The D12 structured-YAML schema (merge_conventions / " +
          "additional_blockers) lands in PR 4. Free-form strings " +
          "are rejected to avoid locking in the wrong stored shape.",
      };
    }
  }
  return {
    ok: true,
    body: {
      queen_mode: obj.queen_mode,
      queen_prompt_override: override,
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
      // D9 + G37 in-flight check. Only enforced when the operator is
      // actually changing modes — flipping cloud→cloud or local→local
      // (e.g. updating just the prompt override) doesn't need the
      // gate. PR 3 extends the precheck to cover decided_pending_action
      // + stranded-merge state; today only `deciding` blocks.
      precheck: async (current) => {
        if (current.queen_mode === parsed.body.queen_mode) return null;
        return checkInFlightForFlip({
          installationId: String(installationId),
          redis: auth.redis,
        });
      },
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
