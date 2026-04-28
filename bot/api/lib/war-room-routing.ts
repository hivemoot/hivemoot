/**
 * War-room routing helpers — wrap `WarRoomClient` calls with the
 * bot's "auth-gated, idempotency-aware, non-fatal-on-error" policy.
 *
 * Design intent (Phase E):
 *   - Construction is LAZY — missing `HIVEMOOT_BOT_AGENT_TOKEN`
 *     env var doesn't crash module load. The bot's existing
 *     governance features keep working without war-room
 *     integration; war-room is opt-in via env config until
 *     Phase H fleet migration.
 *   - Idempotent on webhook re-delivery — a `subject_already_open`
 *     409 is treated as success; the existing room is reused.
 *   - Non-fatal on error — war-room failures are logged but never
 *     thrown, so a 500 from the API can't break the PR's existing
 *     intake / governance flow. GitHub re-delivers webhooks on its
 *     own cadence; we'll get another shot.
 */

import { WarRoomClient, WarRoomApiError, prSubjectRef } from "./war-room-client.js";
import type { Logger } from "pino";

interface MaybeCreatePrReviewRoomArgs {
  owner: string;
  repo: string;
  prNumber: number;
  log: Pick<Logger, "info" | "warn" | "error">;
}

interface MaybeCreatePrReviewRoomResult {
  /** The war-room roomId (newly created OR reused via the
   * idempotent 409 path). `null` when the bot has no agent token
   * configured (war-room is disabled in this deployment). */
  roomId: string | null;
  /** Why the room wasn't created when `roomId === null`. Useful for
   * test assertions; logged at info. */
  skipped?: "no_token" | "api_error";
}

/**
 * Create a `pr_review` war room for an opened PR. Returns null and
 * logs a structured info line when:
 *   - `HIVEMOOT_BOT_AGENT_TOKEN` env is unset (bot opted out)
 *   - The API call fails with a 5xx / network error (transient;
 *     GitHub will re-deliver the webhook)
 *
 * On `subject_already_open` 409 (re-delivery for a PR we already
 * have a room for), returns the `existingRoomId` from the response
 * — the bot treats this as success.
 */
export async function maybeCreatePrReviewRoom(
  args: MaybeCreatePrReviewRoomArgs,
): Promise<MaybeCreatePrReviewRoomResult> {
  const token = process.env.HIVEMOOT_BOT_AGENT_TOKEN;
  if (!token) {
    args.log.info(
      {
        owner: args.owner,
        repo: args.repo,
        pr: args.prNumber,
      },
      "[war-room] HIVEMOOT_BOT_AGENT_TOKEN unset — skipping war-room creation. Set the env var to enable Phase E webhook routing.",
    );
    return { roomId: null, skipped: "no_token" };
  }

  let client: WarRoomClient;
  try {
    client = new WarRoomClient({ log: args.log });
  } catch (err) {
    // Construction can throw (invalid baseUrl etc.) — log and skip.
    args.log.error(
      {
        err,
        owner: args.owner,
        repo: args.repo,
        pr: args.prNumber,
      },
      "[war-room] failed to construct WarRoomClient — skipping war-room creation.",
    );
    return { roomId: null, skipped: "api_error" };
  }

  const subject = prSubjectRef({
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
  });

  try {
    const room = await client.createRoom({ subject });
    args.log.info(
      {
        owner: args.owner,
        repo: args.repo,
        pr: args.prNumber,
        roomId: extractRoomIdFromCore(room),
      },
      "[war-room] created pr_review room",
    );
    return { roomId: extractRoomIdFromCore(room) };
  } catch (err) {
    if (err instanceof WarRoomApiError) {
      // Idempotent re-delivery — server already has a room for this
      // subject, reuse the existing roomId.
      if (err.code === "subject_already_open") {
        const existingRoomId = err.response.existingRoomId;
        if (typeof existingRoomId === "string") {
          args.log.info(
            {
              owner: args.owner,
              repo: args.repo,
              pr: args.prNumber,
              existingRoomId,
            },
            "[war-room] subject_already_open — reusing existing room (webhook re-delivery)",
          );
          return { roomId: existingRoomId };
        }
      }
      // Other 4xx → caller config / programmer error. Log loud +
      // skip; don't retry on next webhook (it'll fail the same way).
      args.log.error(
        {
          err,
          status: err.status,
          code: err.code,
          owner: args.owner,
          repo: args.repo,
          pr: args.prNumber,
        },
        "[war-room] API rejected createRoom — skipping",
      );
      return { roomId: null, skipped: "api_error" };
    }
    // Network / 5xx → transient. Log + skip; webhook re-delivery
    // will retry.
    args.log.warn(
      {
        err,
        owner: args.owner,
        repo: args.repo,
        pr: args.prNumber,
      },
      "[war-room] createRoom transient error — skipping (will retry on next webhook delivery)",
    );
    return { roomId: null, skipped: "api_error" };
  }
}

/**
 * Server returns the RoomCore record on POST /api/rooms 201 — the
 * response shape includes `roomId` as a top-level field (mirrored
 * from the storage layer's `RoomCoreWithId` type added in
 * D.1.b-iii). Extract it defensively in case the wire shape adds
 * fields.
 */
function extractRoomIdFromCore(room: unknown): string {
  if (typeof room !== "object" || room === null) return "";
  const roomId = (room as Record<string, unknown>).roomId;
  if (typeof roomId !== "string") {
    // Server response without roomId — log + return empty; caller
    // will surface it as a regular result with no roomId, since
    // the room WAS created (server returned 201). The bot just
    // can't reference it.
    return "";
  }
  return roomId;
}
