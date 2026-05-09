/**
 * Pinning test for the RoomStatus enum at PR 3b. Adds
 * `decided_pending_action` per RFC PR 3 + D4 + G4. The Lua-script
 * wiring + watchdog handling lands in subsequent PR-3 slices; this
 * test documents the surgery surface PR 3c reviewers must verify.
 */

import { describe, it, expect } from "vitest";
import type { RoomStatus } from "./war-room.ts";

describe("RoomStatus enum (PR 3b foundation)", () => {
  it("includes decided_pending_action (RFC PR 3 + D4)", () => {
    // Compile-time assertion: this only typechecks if the type
    // includes the value as a valid member of the union.
    const v: RoomStatus = "decided_pending_action";
    expect(v).toBe("decided_pending_action");
  });

  it("retains the four pre-existing values", () => {
    const open: RoomStatus = "awaiting_contributions";
    const claimed: RoomStatus = "deciding";
    const closed: RoomStatus = "closed";
    const expired: RoomStatus = "expired";
    expect([open, claimed, closed, expired]).toEqual([
      "awaiting_contributions",
      "deciding",
      "closed",
      "expired",
    ]);
  });

  // The following list tracks surgery sites future PR-3 slices must
  // touch. If a list item starts with `[ ]` it's still pending; `[x]`
  // means handled by a subsequent commit/PR. The list is for
  // reviewer awareness — the actual handling lives in the linked
  // commits.
  //
  // [ ] PR 3c — seal-decision endpoint transitions deciding →
  //     decided_pending_action when permitted_action=squash-merge
  //     and comment_url verified.
  // [ ] PR 3c — confirm-merge endpoint transitions
  //     decided_pending_action → closed (audit decision_outcome).
  // [ ] PR 3c — listRooms must continue to return
  //     decided_pending_action rooms in its newest-first slice
  //     (verified by unit test).
  // [ ] PR 3c — status-keyed sorted-set index for
  //     decided_pending_action (mirrors deciding's index).
  // [ ] PR 3c — queen-tick watchdog: rooms in
  //     decided_pending_action past G4's 15min TTL are NOT
  //     auto-recovered by the cloud watchdog (cloud has no merge
  //     surface per G18) — they're owned by the local queen's
  //     confirm-merge loop and the G32 reconciler.
  // [ ] PR 3c — queen-mode-flip-precheck (PR #641) extends to count
  //     decided_pending_action rooms in BlockedReason.counts (D9
  //     full coverage).
  // [ ] PR 3c — observer pass (PR #641) optionally counts these
  //     rooms in `oldestOpenedAtMs` calculation; today they are
  //     `deciding`-derived state and should not double-count.
  // [ ] PR 3c — terminate-room: force-close on a
  //     decided_pending_action room cleans up the same indexes
  //     as a deciding-state force-close.
  it("documents the PR-3c surgery sites (compile-time pin only)", () => {
    // No runtime assertion — the inline checklist above is the
    // contract. This test exists so reviewers grep for it during
    // PR-3c review and walk the list.
    expect(true).toBe(true);
  });
});
