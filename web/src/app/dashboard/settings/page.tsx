import type { Metadata } from "next";
import SettingsDashboard from "./SettingsDashboard";

export const metadata: Metadata = {
  title: "Settings — Hivemoot Dashboard",
  description: "Per-installation configuration including queen execution mode.",
};

/**
 * /dashboard/settings — operator-facing configuration root.
 *
 * Today: hosts the queen-mode toggle (cloud vs local) per the
 * Queen Execution Mode RFC (#628). The mode-toggle calls
 * GET/POST /api/dashboard/queen-settings — see PR 1 (#640) for
 * the storage layer + endpoints, PR 2 (#641) for the
 * D9 in-flight precheck wired into POST.
 *
 * Future siblings (out of this PR's scope):
 *   - G30 reconciliation alarm: lights up when any room is in
 *     decision_outcome=merge_approved + github_merge_status
 *     pending past 5min. Depends on PR 3b's audit fields; ships
 *     in a follow-up.
 *   - 3-signal heartbeat indicator (agent self-report + cloud
 *     observer metric + cloud webhook delivery health per G21).
 *     Depends on PR 2's observer log being exposed via an API.
 *
 * BYOK UI lives at /dashboard/settings/byok per RFC PR 6 (#643).
 * Both pages share the /dashboard/settings parent so operators
 * see a single "configuration" surface.
 */
export default function SettingsPage() {
  return <SettingsDashboard />;
}
