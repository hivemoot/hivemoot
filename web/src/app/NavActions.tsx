"use client";

import Link from "next/link";
import AccountMenu from "./AccountMenu";
import { useSessionStatus } from "./useSessionStatus";

const GET_STARTED_URL = "/setup";
const SIGN_IN_URL = "/api/auth/github/start-discover";

/**
 * Right side of the landing navbar, driven by real session state
 * (useSessionStatus), not just the remembered-user hint.
 *
 * - authenticated → "Dashboard" + account menu (no more re-login loop).
 * - everything else (loading / remembered / anonymous) → "Sign in" + "Get
 *   Started". `loading` deliberately renders the signed-out controls so the
 *   server-rendered HTML matches the first client paint (no hydration
 *   mismatch); it swaps to the dashboard controls once the probe resolves.
 */
export default function NavActions() {
  const nav = useSessionStatus();

  if (nav.kind === "authenticated") {
    return (
      <>
        <Link
          href="/dashboard"
          className="rounded-md bg-honey-500 px-4 py-2 text-sm font-semibold text-[#111114] transition-all hover:bg-honey-400 hover:shadow-lg hover:shadow-honey-500/20"
        >
          Dashboard
        </Link>
        <AccountMenu login={nav.login} />
      </>
    );
  }

  return (
    <>
      <a
        href={SIGN_IN_URL}
        className="text-sm text-zinc-400 transition-colors hover:text-[#fafafa]"
      >
        Sign in
      </a>
      <Link
        href={GET_STARTED_URL}
        className="rounded-md bg-honey-500 px-4 py-2 text-sm font-semibold text-[#111114] transition-all hover:bg-honey-400 hover:shadow-lg hover:shadow-honey-500/20"
      >
        Get Started
      </Link>
    </>
  );
}
