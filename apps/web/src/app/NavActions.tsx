"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { REMEMBERED_USER_COOKIE, GITHUB_LOGIN_RE } from "@/constants/cookies";
import { getCookie } from "@/lib/cookies";

const GET_STARTED_URL = "/setup";

/**
 * Client component that renders the right side of the landing-page navbar.
 *
 * Hydration approach: state starts null, so server and client both render the
 * Sign in / Get Started buttons on initial render — no mismatch. After mount,
 * if the cookie is present and valid, the buttons are replaced with the user's
 * GitHub avatar chip.
 *
 * Note: unlike RememberedUserCard (which renders null before mount and hides
 * entirely), this component always shows the Sign in / Get Started fallback on
 * initial render. Both are hydration-safe, but via different initial states.
 */
export default function NavActions() {
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    const raw = getCookie(REMEMBERED_USER_COOKIE);
    if (raw && GITHUB_LOGIN_RE.test(raw)) {
      setUser(raw); // eslint-disable-line react-hooks/set-state-in-effect -- browser-only init after hydration; empty deps = runs once
    }
  }, []);

  if (user) {
    return (
      <a
        href="/api/auth/github/start-discover"
        aria-label={`Continue as @${user}`}
        className="flex items-center gap-2 rounded-full border border-zinc-700/60 bg-zinc-900/70 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-all hover:border-honey-500/40 hover:bg-zinc-900"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`https://github.com/${user}.png?size=64`}
          alt=""
          aria-hidden="true"
          className="h-6 w-6 rounded-full border border-zinc-700"
          onError={(e) => {
            // Hide on CDN failure rather than showing a broken-image icon.
            // The @username chip adjacent to the avatar already identifies the
            // user; a generic placeholder image would add no useful information.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        <span className="text-zinc-300">@{user}</span>
      </a>
    );
  }

  return (
    <>
      <a
        href="/api/auth/github/start-discover"
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
