"use client";

import AccountMenu from "../AccountMenu";
import { useSessionStatus } from "../useSessionStatus";

/**
 * Account menu (switch account / sign out) for the dashboard header. The
 * dashboard is always behind a session, so once the probe resolves we show
 * the menu; while it's in flight we render nothing to avoid a flash.
 */
export default function DashboardAccount() {
  const nav = useSessionStatus();
  if (nav.kind !== "authenticated") return null;
  return <AccountMenu login={nav.login} />;
}
