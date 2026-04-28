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
import { createHash } from "node:crypto";

/**
 * Derive a deterministic UUIDv4-shaped roomId from a PR's identity.
 * Both `pull_request.opened` (E.1) and `pull_request.synchronize`
 * (E.2) call this with the same arguments and get the same roomId
 * — so the bot can act on the room across webhook events without
 * first looking it up.
 *
 * Why deterministic: webhooks for the same PR fire from different
 * bot processes / deliveries. Without a deterministic derivation,
 * each fire would mint a fresh UUID, hitting the storage layer's
 * `subject_already_open` 409 every time and forcing an extra
 * round-trip to recover the existing roomId.
 *
 * SHA-256(`${owner}/${repo}#${prNumber}`) → first 32 hex chars,
 * formatted as UUIDv4 (set version + variant bits per RFC 4122).
 * The storage layer's regex
 * `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
 * enforces UUIDv4 format; this helper produces a string that
 * matches that regex while remaining stable per PR.
 */
export function derivePrRoomId(args: {
  owner: string;
  repo: string;
  prNumber: number;
}): string {
  const subject = `${args.owner}/${args.repo}#${args.prNumber}`;
  const hash = createHash("sha256").update(subject).digest("hex");
  // Format hex chars as UUID: 8-4-4-4-12.
  // Then patch the version nibble (13th hex char → "4") and the
  // variant nibble (17th hex char → 8/9/a/b) to satisfy UUIDv4.
  const chars = hash.slice(0, 32).split("");
  chars[12] = "4"; // version 4
  // Variant bits: top two bits of byte 8 must be 10. Mask the high
  // nibble: 0b10xx → "8" | "9" | "a" | "b".
  const variantNibble = (parseInt(chars[16], 16) & 0x3) | 0x8;
  chars[16] = variantNibble.toString(16);
  const joined = chars.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`;
}

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

  // Deterministic roomId derived from the PR identity (E.2).
  // Same `owner/repo#N` always maps to the same UUIDv4-shaped id,
  // so synchronize / closed events can hit the same room without
  // a server-side lookup. Closes #526 guard B1 (no dependency on
  // the POST 201 response shape — bot owns the id end-to-end).
  const roomId = derivePrRoomId({
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
  });

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

interface MaybeEmitSubjectUpdatedArgs {
  owner: string;
  repo: string;
  prNumber: number;
  /** What changed — included in the event body for forensic /
   * worker-triage signal. */
  changeKind: "synchronize" | "closed" | "reopened";
  /** Optional: head SHA after the change (for synchronize events).
   * Lets workers' triage logic detect "did the diff actually
   * change" vs "noise event". */
  headSha?: string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

interface MaybeEmitSubjectUpdatedResult {
  /** Sequence the event landed at, OR null when skipped. */
  sequence: number | null;
  skipped?: "no_token" | "api_error" | "no_room";
}

/**
 * Emit a `subject_updated` event on the war-room corresponding to
 * a PR (synchronize / closed / reopened). Returns null + skipped
 * code when:
 *   - `HIVEMOOT_BOT_AGENT_TOKEN` env unset (war-room disabled)
 *   - The room doesn't exist (PR never had a war-room — likely a
 *     PR opened before war-room integration was enabled, or
 *     transient API failure on E.1's create call)
 *   - Status precondition fail (room is `closed` or `deciding` —
 *     queen has the claim or it's already terminal)
 *   - Network / 5xx (transient; webhook re-delivery doesn't fire
 *     because the helper still returns 200 to GitHub)
 *
 * Idempotency: caller-supplied key derives from a stable
 * `(roomId, action, headSha)` tuple — webhook re-deliveries with
 * the same head SHA don't duplicate events.
 *
 * Status precondition (`awaiting_rsvp` / `awaiting_contributions`
 * only): if the queen has claimed the room (status `deciding`),
 * the bot's webhook event is buffered until queen releases — that
 * deferral mechanism is Phase G' (queen module). For E.2, a
 * `status_precondition_failed` 409 is logged + skipped; no
 * automatic retry.
 */
export async function maybeEmitSubjectUpdated(
  args: MaybeEmitSubjectUpdatedArgs,
): Promise<MaybeEmitSubjectUpdatedResult> {
  const token = process.env.HIVEMOOT_BOT_AGENT_TOKEN;
  if (!token) {
    args.log.info(
      { owner: args.owner, repo: args.repo, pr: args.prNumber },
      "[war-room] HIVEMOOT_BOT_AGENT_TOKEN unset — skipping subject_updated",
    );
    return { sequence: null, skipped: "no_token" };
  }

  let client: WarRoomClient;
  try {
    client = new WarRoomClient({ log: args.log });
  } catch (err) {
    args.log.error(
      { err, owner: args.owner, repo: args.repo, pr: args.prNumber },
      "[war-room] failed to construct WarRoomClient — skipping subject_updated",
    );
    return { sequence: null, skipped: "api_error" };
  }

  const roomId = derivePrRoomId({
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
  });

  // Idempotency key derived from (roomId, action, headSha). Same
  // PR + same head SHA = same key, so re-delivery of the same
  // synchronize event doesn't duplicate the audit entry.
  const idempotencyKey = `bot.subject_updated.${roomId}.${args.changeKind}.${args.headSha ?? "no-sha"}`;

  const body: Record<string, unknown> = {
    change_kind: args.changeKind,
  };
  if (args.headSha !== undefined) body.head_sha = args.headSha;

  try {
    const result = await client.appendEvent({
      roomId,
      eventType: "subject_updated",
      body,
      idempotencyKey,
    });
    args.log.info(
      {
        owner: args.owner,
        repo: args.repo,
        pr: args.prNumber,
        roomId,
        sequence: result.sequence,
        replay: result.replay ?? false,
        changeKind: args.changeKind,
      },
      "[war-room] emitted subject_updated event",
    );
    return { sequence: result.sequence };
  } catch (err) {
    if (err instanceof WarRoomApiError) {
      if (err.code === "room_not_found") {
        // Room doesn't exist for this PR — likely the PR was
        // opened before war-room integration was enabled, or
        // E.1's create call failed transiently. Log + skip.
        args.log.info(
          {
            owner: args.owner,
            repo: args.repo,
            pr: args.prNumber,
            roomId,
            changeKind: args.changeKind,
          },
          "[war-room] room not found for PR — likely opened pre-war-room or E.1 failed; skipping subject_updated",
        );
        return { sequence: null, skipped: "no_room" };
      }
      // Status precondition (`closed` / `deciding`), validation,
      // etc. — log + skip.
      args.log.warn(
        {
          err,
          status: err.status,
          code: err.code,
          owner: args.owner,
          repo: args.repo,
          pr: args.prNumber,
          roomId,
          changeKind: args.changeKind,
        },
        "[war-room] API rejected subject_updated — skipping (queen-claimed or terminal room)",
      );
      return { sequence: null, skipped: "api_error" };
    }
    args.log.warn(
      {
        err,
        owner: args.owner,
        repo: args.repo,
        pr: args.prNumber,
        roomId,
        changeKind: args.changeKind,
      },
      "[war-room] subject_updated transient error — skipping (no auto-retry; see file docstring)",
    );
    return { sequence: null, skipped: "api_error" };
  }
}

