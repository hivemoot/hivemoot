/**
 * War-room routing helpers — wrap `WarRoomStore` calls with the
 * bot's "idempotency-aware, non-fatal-on-error" policy.
 *
 * Design intent:
 *   - Construction is LAZY — missing `HIVEMOOT_REDIS_REST_URL` /
 *     `HIVEMOOT_REDIS_REST_TOKEN` env vars don't crash module
 *     load. The bot's existing governance features keep working
 *     without war-room integration; war-room is opt-in via the
 *     Redis env config (which is also used by `byok.ts`).
 *   - Idempotent on webhook re-delivery — a `subject_already_open`
 *     409 is treated as success; the existing room is reused.
 *   - Non-fatal on error — war-room failures are logged but never
 *     thrown, so a Redis outage can't break the PR's existing
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

import { WarRoomStore, WarRoomApiError, prSubjectRef } from "./war-room-store.js";
import { getRedisClient } from "./redis.js";
import type { Logger } from "pino";
import { createHash } from "node:crypto";

/**
 * Construct a per-installation `WarRoomStore` while preserving the
 * file-level non-fatal contract. Returns `null` on:
 *
 *   - Missing `HIVEMOOT_REDIS_REST_URL` / `_TOKEN` env (deployment
 *     hasn't enabled war-rooms yet — same posture as the previous
 *     missing-bearer skip path)
 *   - Missing / `"0"` / non-numeric `installationId` (webhook payload
 *     didn't include `installation.id` — drop the call instead of
 *     writing to a phantom tenant namespace, closes #581 guard B1)
 *   - Any other thrown construction error (defense-in-depth)
 *
 * On failure, logs a structured warning at `log.warn` (always
 * available — Probot's context.log carries it). Caller branches on
 * the null return to short-circuit with their own
 * `{ skipped: "no_config" | "no_installation" | "api_error" }`
 * variant.
 *
 * Closes #581 guard B2: previously, `getRedisClient()` and
 * `new WarRoomStore` were called OUTSIDE each helper's try block, so
 * a missing env var would propagate to the webhook handler's outer
 * catch and re-throw — turning "war-room is off" config into "the
 * whole bot returns 5xx for every PR/comment webhook."
 */
function tryConstructStore(args: {
  installationId: number | string | undefined | null;
  log: Pick<Logger, "info" | "warn" | "error">;
  context: Record<string, unknown>;
}): WarRoomStore | { skipped: "no_installation" | "no_config" } {
  const rawId = args.installationId;
  if (rawId === null || rawId === undefined || rawId === "" || rawId === 0) {
    args.log.warn(
      args.context,
      "[war-room] webhook payload had no installation.id — skipping war-room call (would write to a phantom tenant namespace).",
    );
    return { skipped: "no_installation" };
  }
  const installationId = String(rawId);
  try {
    return new WarRoomStore({
      installationId,
      redis: getRedisClient(),
      log: args.log,
    });
  } catch (err) {
    args.log.warn(
      { ...args.context, err },
      "[war-room] WarRoomStore construction failed (likely missing HIVEMOOT_REDIS_REST_URL/TOKEN or invalid installationId) — skipping war-room call.",
    );
    return { skipped: "no_config" };
  }
}

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
  return derivedUuidV4(`${args.owner}/${args.repo}#${args.prNumber}`);
}

/**
 * Derive a deterministic UUIDv4-shaped roomId for a mention-response.
 *
 * Includes `commentId` in the derivation so:
 *
 *   1. **Post-close mention safety**: storage retains room hashes
 *      for ~30 days after close. Without `commentId` in the
 *      derivation, a mention 31+ days after the previous mention's
 *      room closed would re-derive the SAME roomId and collide on
 *      `room_id_taken`. With it, each mention gets a fresh
 *      derivation. Closes #549 builder R1 #2 (post-close).
 *
 *   2. **Same-issue re-mention safety**: if a prior mention's room
 *      is still open and a new mention arrives, the create attempt
 *      uses a DIFFERENT roomId, so the create fails on
 *      `subject_already_open` (subject_ref is per-issue, regardless
 *      of comment). The caller then resolves the existing roomId
 *      from the 409 response and emits a `subject_updated` event so
 *      workers re-engage. Closes #549 builder R1 #2 (re-mention).
 *
 * Distinct namespace from `derivePrRoomId` via the `mention:` prefix.
 */
export function deriveMentionRoomId(args: {
  owner: string;
  repo: string;
  issueOrPrNumber: number;
  commentId: number;
}): string {
  return derivedUuidV4(
    `mention:${args.owner}/${args.repo}#${args.issueOrPrNumber}:${args.commentId}`,
  );
}

/**
 * Internal: hash the input string into a UUIDv4-formatted id (32 hex
 * chars + version + variant nibble fixups, 8-4-4-4-12 layout).
 * Storage's regex
 * `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
 * enforces UUIDv4 format; this helper produces a string that
 * matches while remaining stable per input.
 */
function derivedUuidV4(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex");
  const chars = hash.slice(0, 32).split("");
  chars[12] = "4"; // version 4
  const variantNibble = (parseInt(chars[16], 16) & 0x3) | 0x8;
  chars[16] = variantNibble.toString(16);
  const joined = chars.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20, 32)}`;
}

/**
 * Match the literal `@hivemoot` mention NOT followed by a word
 * character or hyphen. Excludes `@hivemoot-builder`, `@hivemoot_test`,
 * etc., which are distinct GitHub identities. Anchors:
 *   - Start of string OR non-word boundary before `@hivemoot`
 *   - End of string OR non-`[\w-]` char after the `t`
 *
 * Case-insensitive (`hello @Hivemoot` works).
 */
const HIVEMOOT_MENTION_REGEX = /(?:^|\W)@hivemoot(?![\w-])/i;

/**
 * Detect a `@hivemoot` mention in a comment body. Skips zero-length
 * bodies and bodies starting with `/` (which are command comments
 * routed elsewhere).
 *
 * The intent is conservative: a comment that's primarily a /command
 * shouldn't ALSO trigger mention-room creation — operators clicking
 * `/gather` etc. don't expect a war room to spawn. Mid-comment
 * mentions inside a /command body are a real edge case but rare;
 * they fall through to the command path only.
 */
export function commentHasHivemootMention(commentBody: string): boolean {
  if (typeof commentBody !== "string" || commentBody.length === 0) {
    return false;
  }
  if (commentBody.trimStart().startsWith("/")) {
    return false; // command comment — don't double-route
  }
  return HIVEMOOT_MENTION_REGEX.test(commentBody);
}

interface MaybeCreatePrReviewRoomArgs {
  owner: string;
  repo: string;
  prNumber: number;
  /** GitHub App installation id from the webhook payload
   * (`payload.installation.id`). Per-tenant scoping for the
   * direct-Redis path: each call constructs a per-installation
   * store, so cross-tenant data never enters this code path. */
  installationId: number | string | undefined;
  log: Pick<Logger, "info" | "warn" | "error">;
}

interface MaybeCreatePrReviewRoomResult {
  /** The war-room roomId (newly created OR reused via the
   * idempotent `subject_already_open` path). `null` when the call
   * was skipped (missing payload installation, missing Redis env,
   * config error) or when a recoverable Redis error surfaced. */
  roomId: string | null;
  /** Why the room wasn't created when `roomId === null`. Useful for
   * test assertions; logged at info/warn. */
  skipped?: "no_installation" | "no_config" | "api_error";
}

/**
 * Create a `pr_review` war room for an opened PR. Returns null and
 * logs a structured warning when:
 *   - The Redis call fails with a transient error (next webhook
 *     re-delivery may retry, but the bot's outer handler swallows
 *     errors so GitHub itself does NOT auto-redeliver — see #526
 *     guard N1 in the file docstring above).
 *
 * On `subject_already_open` 409 (re-delivery for a PR we already
 * have a room for), returns the `existingRoomId` from the response
 * — the bot treats this as success.
 */
export async function maybeCreatePrReviewRoom(
  args: MaybeCreatePrReviewRoomArgs,
): Promise<MaybeCreatePrReviewRoomResult> {
  const constructed = tryConstructStore({
    installationId: args.installationId,
    log: args.log,
    context: { owner: args.owner, repo: args.repo, pr: args.prNumber },
  });
  if (!(constructed instanceof WarRoomStore)) {
    return { roomId: null, skipped: constructed.skipped };
  }
  const store = constructed;

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
    // 180s quiet_period_secs: tuned for PR review fleets where
    // each agent's triage takes ~1-3min.  The default 600s leaves
    // every PR sitting for 10min after the first contribution
    // before synthesis fires, which is too long for reviewer
    // feedback.  At 180s, the manager-loop's quiet-period gate
    // gives slower agents up to 3min after the latest event to
    // catch up before claiming.  Combined with the 2-min cron
    // cadence, end-to-end is ~4-5min from last contribution to
    // synthesis comment.
    await store.createRoom({
      subject,
      roomId,
      timing: { quiet_period_secs: 180 },
    });
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
    // Network / 5xx → transient. Log + skip; the helper still
    // returns 200 to GitHub via the webhook handler, so there is no
    // automatic re-delivery. See file docstring.
    args.log.warn(
      {
        err,
        owner: args.owner,
        repo: args.repo,
        pr: args.prNumber,
      },
      "[war-room] createRoom transient error — skipping (no auto-retry; see file docstring)",
    );
    return { roomId: null, skipped: "api_error" };
  }
}

interface MaybeEmitSubjectUpdatedArgs {
  owner: string;
  repo: string;
  prNumber: number;
  /** GitHub App installation id (`payload.installation.id`). */
  installationId: number | string | undefined;
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
  skipped?: "api_error" | "no_room" | "no_installation" | "no_config";
}

/**
 * Emit a `subject_updated` event on the war-room corresponding to
 * a PR (synchronize / closed / reopened). Returns null + skipped
 * code when:
 *   - The room doesn't exist (PR never had a war-room — likely a
 *     PR opened before war-room integration was enabled, or
 *     transient failure on E.1's create call)
 *   - Status precondition fail (room is `closed` or `deciding` —
 *     queen has the claim or it's already terminal)
 *   - Transient Redis error
 *
 * Idempotency: caller-supplied key derives from a stable
 * `(roomId, action, headSha)` tuple — webhook re-deliveries with
 * the same head SHA don't duplicate events.
 *
 * Status precondition (`awaiting_contributions` only — heartbeat
 * model collapses the pre-decide states): if the queen has claimed
 * the room (status `deciding`),
 * the bot's webhook event is buffered until queen releases — that
 * deferral mechanism is Phase G' (queen module). For E.2, a
 * `status_precondition_failed` 409 is logged + skipped; no
 * automatic retry.
 */
export async function maybeEmitSubjectUpdated(
  args: MaybeEmitSubjectUpdatedArgs,
): Promise<MaybeEmitSubjectUpdatedResult> {
  const constructed = tryConstructStore({
    installationId: args.installationId,
    log: args.log,
    context: { owner: args.owner, repo: args.repo, pr: args.prNumber },
  });
  if (!(constructed instanceof WarRoomStore)) {
    return { sequence: null, skipped: constructed.skipped };
  }
  const store = constructed;

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
    const result = await store.appendEvent({
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
      // Persist a drift marker so the dashboard can render a
      // "diff drifted post-verdict" badge — the verdict the room
      // synthesized over an earlier head SHA, but the PR has since
      // advanced past what it reviewed. Closes hivemoot/hivemoot#605
      // (Option A). Only the precondition-failure code maps to drift;
      // other codes (validation, body-too-large, etc.) are caller
      // bugs, not state-machine drift.
      if (err.code === "status_precondition_failed") {
        try {
          await store.recordPostCloseDrift({
            roomId,
            attemptedAt: new Date().toISOString(),
            headSha: args.headSha,
          });
        } catch (driftErr) {
          // Non-fatal: a failure to persist the badge marker MUST
          // NOT escalate the webhook handler's 200 response. Log and
          // move on — the operator still sees the warn-level rejection
          // log above; the badge is a UI nicety.
          args.log.warn(
            {
              err: driftErr,
              roomId,
              changeKind: args.changeKind,
            },
            "[war-room] failed to persist post-close drift marker — non-fatal",
          );
        }
      }
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

// ---------------------------------------------------------------------------
// E.3 — mention_response rooms on @hivemoot comments
// ---------------------------------------------------------------------------

interface MaybeCreateMentionRoomArgs {
  owner: string;
  repo: string;
  /** The issue OR PR number — same field on the GitHub `issue` payload
   * for both. The mention_response subject_ref shape doesn't
   * distinguish; the room's downstream consumers can read
   * `pull_request` on the original webhook payload if they need to. */
  issueOrPrNumber: number;
  /** GitHub App installation id (`payload.installation.id`). */
  installationId: number | string | undefined;
  /** GitHub comment.id of the @hivemoot mention. Folded into the
   * deterministic roomId so each mention gets a fresh room (post-
   * close safety) AND used as the `subject_updated` event's
   * idempotency key when the issue already has an open mention room
   * (re-mention safety). */
  commentId: number;
  /** GitHub login of the comment author. Logged for ops triage —
   * NOT used for any access decision (the bot's own GitHub App
   * identity is what authorizes the room creation; per-tenant
   * scoping comes from `installationId`). */
  commentAuthor: string;
  log: Pick<Logger, "info" | "warn" | "error">;
}

interface MaybeCreateMentionRoomResult {
  /** The war-room roomId. May be:
   *   - The newly-created room (this comment opened a fresh mention room)
   *   - The pre-existing open room for this issue (re-mention path —
   *     a `subject_updated` event was emitted to advance its seq)
   *   - `null` when an unrecoverable Redis error occurred.
   */
  roomId: string | null;
  /** Whether the room already existed and we emitted subject_updated
   * instead of creating fresh. False when newly created. False
   * when roomId is null. */
  reusedExistingRoom?: boolean;
  /** Why the room wasn't created when `roomId === null`. */
  skipped?: "api_error" | "no_installation" | "no_config";
}

/**
 * Create a `mention_response` war room for an @hivemoot comment on
 * an issue or PR. Multiple mentions on the same issue/PR get the
 * SAME roomId (deterministic per `(owner, repo, issueOrPrNumber)`)
 * — so subsequent mentions reuse the existing room via the
 * `subject_already_open` 409 path. Once that room closes, a new
 * mention will create a fresh room (storage frees the subject).
 *
 * Non-fatal-on-error policy preserved:
 *   - 409 `subject_already_open` → reuse existing roomId
 *   - other 4xx → log + return null
 *   - 5xx / Redis transient → log + return null
 *
 * The webhook handler invokes this helper AFTER the /command parser
 * has rejected the comment (a comment that's primarily a /command
 * should NOT also spawn a mention room — see
 * `commentHasHivemootMention`'s `/`-prefix guard).
 */
export async function maybeCreateMentionRoom(
  args: MaybeCreateMentionRoomArgs,
): Promise<MaybeCreateMentionRoomResult> {
  const constructed = tryConstructStore({
    installationId: args.installationId,
    log: args.log,
    context: {
      owner: args.owner,
      repo: args.repo,
      issueOrPrNumber: args.issueOrPrNumber,
      commentAuthor: args.commentAuthor,
    },
  });
  if (!(constructed instanceof WarRoomStore)) {
    return { roomId: null, skipped: constructed.skipped };
  }
  const store = constructed;

  const subject = {
    type: "mention_response" as const,
    ref: `${args.owner}/${args.repo}#${args.issueOrPrNumber}`,
  };
  const roomId = deriveMentionRoomId({
    owner: args.owner,
    repo: args.repo,
    issueOrPrNumber: args.issueOrPrNumber,
    commentId: args.commentId,
  });

  try {
    // 180s quiet_period_secs: see pr_review path above for the
    // tuning rationale — same fleet, same engine wall-time profile.
    await store.createRoom({
      subject,
      roomId,
      timing: { quiet_period_secs: 180 },
    });
    args.log.info(
      {
        owner: args.owner,
        repo: args.repo,
        issueOrPrNumber: args.issueOrPrNumber,
        commentId: args.commentId,
        commentAuthor: args.commentAuthor,
        roomId,
      },
      "[war-room] created mention_response room",
    );
    return { roomId, reusedExistingRoom: false };
  } catch (err) {
    if (err instanceof WarRoomApiError) {
      if (err.code === "subject_already_open") {
        const existingRoomId = err.response.existingRoomId;
        if (typeof existingRoomId === "string") {
          // Two cases collapse into subject_already_open and we MUST
          // distinguish them — closes #549 builder R2:
          //
          //   (a) Same-comment webhook redelivery: the room WE
          //       created on the first delivery still exists, so
          //       existingRoomId === our derived roomId. This is an
          //       idempotent replay; emitting subject_updated would
          //       falsely advance the sequence and re-dispatch
          //       workers for a non-event.
          //
          //   (b) Different-comment re-mention: a prior comment's
          //       room is still open and a NEW @hivemoot landed.
          //       existingRoomId !== our derived roomId (different
          //       commentId in the derivation). Emit subject_updated
          //       so workers re-engage.
          if (existingRoomId === roomId) {
            args.log.info(
              {
                owner: args.owner,
                repo: args.repo,
                issueOrPrNumber: args.issueOrPrNumber,
                commentId: args.commentId,
                roomId,
              },
              "[war-room] same-comment webhook redelivery — idempotent replay, no subject_updated emit",
            );
            return { roomId, reusedExistingRoom: false };
          }
          return await emitMentionSubjectUpdated({
            store,
            owner: args.owner,
            repo: args.repo,
            issueOrPrNumber: args.issueOrPrNumber,
            commentId: args.commentId,
            commentAuthor: args.commentAuthor,
            existingRoomId,
            log: args.log,
          });
        }
      }
      args.log.error(
        {
          err,
          status: err.status,
          code: err.code,
          owner: args.owner,
          repo: args.repo,
          issueOrPrNumber: args.issueOrPrNumber,
          commentId: args.commentId,
        },
        "[war-room] API rejected mention_response create — skipping (config / programmer error; see code).",
      );
      return { roomId: null, skipped: "api_error" };
    }
    args.log.warn(
      {
        err,
        owner: args.owner,
        repo: args.repo,
        issueOrPrNumber: args.issueOrPrNumber,
        commentId: args.commentId,
      },
      "[war-room] mention_response create transient error — skipping (no auto-retry; see file docstring)",
    );
    return { roomId: null, skipped: "api_error" };
  }
}

/**
 * Emit a `subject_updated` event on an existing mention room when a
 * fresh @hivemoot comment lands on the same issue. The event's
 * idempotency key is keyed by `commentId` so re-deliveries of the
 * same webhook resolve to the same event (not duplicated). Workers
 * see the bumped sequence via /watching and re-engage if they had
 * withdrawn/resolved on the prior mention.
 */
async function emitMentionSubjectUpdated(args: {
  store: WarRoomStore;
  owner: string;
  repo: string;
  issueOrPrNumber: number;
  commentId: number;
  commentAuthor: string;
  existingRoomId: string;
  log: Pick<Logger, "info" | "warn" | "error">;
}): Promise<MaybeCreateMentionRoomResult> {
  const idempotencyKey = `bot.subject_updated.${args.existingRoomId}.mention.${args.commentId}`;
  try {
    await args.store.appendEvent({
      roomId: args.existingRoomId,
      eventType: "subject_updated",
      body: {
        change_kind: "mention",
        comment_id: args.commentId,
        comment_author: args.commentAuthor,
      },
      idempotencyKey,
    });
    args.log.info(
      {
        owner: args.owner,
        repo: args.repo,
        issueOrPrNumber: args.issueOrPrNumber,
        commentId: args.commentId,
        commentAuthor: args.commentAuthor,
        existingRoomId: args.existingRoomId,
      },
      "[war-room] re-mention on existing room — emitted subject_updated to re-engage workers",
    );
    return { roomId: args.existingRoomId, reusedExistingRoom: true };
  } catch (err) {
    if (err instanceof WarRoomApiError) {
      args.log.warn(
        {
          err,
          status: err.status,
          code: err.code,
          owner: args.owner,
          repo: args.repo,
          issueOrPrNumber: args.issueOrPrNumber,
          commentId: args.commentId,
          existingRoomId: args.existingRoomId,
        },
        "[war-room] re-mention subject_updated rejected (room may have just closed) — skipping",
      );
      return { roomId: args.existingRoomId, skipped: "api_error" };
    }
    args.log.warn(
      {
        err,
        owner: args.owner,
        repo: args.repo,
        issueOrPrNumber: args.issueOrPrNumber,
        commentId: args.commentId,
        existingRoomId: args.existingRoomId,
      },
      "[war-room] re-mention subject_updated transient error — skipping",
    );
    return { roomId: args.existingRoomId, skipped: "api_error" };
  }
}
