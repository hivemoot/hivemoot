"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { REMEMBERED_USER_COOKIE, GITHUB_LOGIN_RE } from "@/constants/cookies";

function getCookie(name: string): string | null {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${name}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

const GET_STARTED_URL = "/setup";

/**
 * Client component that renders the right side of the landing-page navbar.
 *
 * Reads the remembered-user cookie after mount (same hydration-safe pattern
 * as RememberedUserCard). Both server and client initially render the default
 * Sign in / Get Started buttons — no hydration mismatch. After mount, if the
 * cookie is present, the buttons are replaced with the user's GitHub avatar.
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
