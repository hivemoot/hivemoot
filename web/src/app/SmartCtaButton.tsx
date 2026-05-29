"use client";

import Link from "next/link";
import { useSessionStatus } from "./useSessionStatus";

/**
 * A single primary CTA whose destination follows session state: signed-in
 * users go to the dashboard, everyone else into setup. Used by the secondary
 * CTA band so a logged-in visitor is never offered "Get started → onboard".
 * While the session probe is in flight it shows the signed-out label (matches
 * SSR), then swaps once resolved.
 */
export default function SmartCtaButton({ className }: { className: string }) {
  const nav = useSessionStatus();
  const authed = nav.kind === "authenticated";

  return (
    <Link href={authed ? "/dashboard" : "/setup"} className={className}>
      {authed ? "Open dashboard" : "Get started"}
      <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}
