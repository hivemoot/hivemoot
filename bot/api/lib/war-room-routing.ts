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
 *     intake / governance flow.
 *
 * **Recovery story (closes #526 guard N1):** because the routing
 * helper SWALLOWS errors and returns 200 to GitHub, GitHub does NOT
 * automatically re-deliver. A single transient war-room API failure
 * on `pull_request.opened` means the war-room is never created for
 * that PR until E.2 (`pull_request.synchronize` re-attempt) or
 * operator intervention. Re-throwing on 5xx is the alternative —
 * but that re-runs the existing intake/comment-posting flow, whose
 * idempotency under repeat deliveries isn't asserted today. Tracked
 * as a follow-up; pre-Phase H opt-in posture limits blast radius.
 */

import { WarRoomClient, WarRoomApiError, prSubjectRef } from "./war-room-client.js";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";

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

  // Bot-side mint of the roomId (closes #526 guard B1). The server
  // accepts a caller-supplied roomId via POST /api/rooms body and
  // falls back to its own crypto.randomUUID() if omitted. The
  // 201 response serializes RoomCore (NOT RoomCoreWithId) — no
  // roomId in the body — so threading the minted value through
  // makes the contract self-consistent: caller knows the roomId
  // before the round-trip, no response-shape dependency.
  //
  // Future E.x slices (subject_updated, terminate, post-PR-comment
  // referencing the room) get the roomId for free via this return
  // value.
  const roomId = randomUUID();

  try {
    await client.createRoom({ subject, roomId });
    args.log.info(
      {
        owner: args.owner,
        repo: args.repo,
        pr: args.prNumber,
        roomId,
      },
      "[war-room] created pr_review room",
    );
    return { roomId };
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

