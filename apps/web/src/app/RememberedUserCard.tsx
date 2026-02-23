"use client";

import { useEffect, useState } from "react";
import { REMEMBERED_USER_COOKIE, GITHUB_LOGIN_RE } from "@/constants/cookies";

function getCookie(name: string): string | null {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${name}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Client component that reads the remembered-user cookie and renders a
 * "Continue as @username" card. Runs client-side so the landing page can
 * remain statically generated.
 *
 * Uses useEffect so both server and client initially render null (no
 * hydration mismatch). The cookie is read once after mount.
 */
export default function RememberedUserCard() {
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    const raw = getCookie(REMEMBERED_USER_COOKIE);
    if (raw && GITHUB_LOGIN_RE.test(raw)) {
      setUser(raw); // eslint-disable-line react-hooks/set-state-in-effect -- browser-only init after hydration; empty deps = runs once
    }
  }, []);

  if (!user) return null;

  return (
    <div className="mb-6 flex justify-center">
      <a
        href="/api/auth/github/start-discover"
        className="flex items-center gap-3 rounded-xl border border-zinc-700/60 bg-zinc-900/70 px-5 py-3 text-sm font-medium text-zinc-200 transition-all hover:border-honey-500/40 hover:bg-zinc-900"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`https://github.com/${user}.png?size=64`}
          alt=""
          aria-hidden="true"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
          className="h-7 w-7 rounded-full border border-zinc-700"
        />
        Continue as{" "}
        <span className="text-honey-400">@{user}</span>
        <svg
          className="h-4 w-4 text-zinc-500"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M6 3l5 5-5 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
    </div>
  );
}
