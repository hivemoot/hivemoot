"use client";

import Link from "next/link";
import { useSessionStatus } from "./useSessionStatus";

const GET_STARTED_URL = "/setup";
const SIGN_IN_URL = "/api/auth/github/start-discover";
const GITHUB_URL = "https://github.com/hivemoot/hivemoot";

function ArrowIcon() {
  return (
    <svg
      className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GitHubButton() {
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-7 py-3.5 text-base font-semibold text-zinc-300 transition-all hover:border-zinc-600 hover:text-[#fafafa]"
    >
      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836a9.59 9.59 0 012.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
      </svg>
      View on GitHub
    </a>
  );
}

const PRIMARY_CTA =
  "group inline-flex items-center gap-2 rounded-lg bg-honey-500 px-7 py-3.5 text-base font-bold text-[#111114] transition-all hover:bg-honey-400 hover:shadow-xl hover:shadow-honey-500/25";

/**
 * Hero call-to-action region, auth-aware.
 *
 * - authenticated → "Open dashboard" (→ /dashboard) so a signed-in user is
 *   never sent back through onboarding.
 * - remembered (signed out, but we know the last login) → a "Continue as
 *   @user" one-tap re-auth card above the standard "Get Started".
 * - anonymous / loading → "Get Started" (→ /setup). `loading` renders the
 *   anonymous layout so SSR and first paint match and there's no shift.
 */
export default function HeroActions() {
  const nav = useSessionStatus();

  if (nav.kind === "authenticated") {
    return (
      <div className="flex flex-col items-center gap-4">
        {nav.login && (
          <p className="text-sm text-zinc-500">
            Signed in as <span className="text-honey-400">@{nav.login}</span>
          </p>
        )}
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <Link href="/dashboard" className={PRIMARY_CTA}>
            Open dashboard
            <ArrowIcon />
          </Link>
          <GitHubButton />
        </div>
      </div>
    );
  }

  return (
    <>
      {nav.kind === "remembered" && (
        <div className="mb-6 flex justify-center">
          <a
            href={SIGN_IN_URL}
            className="flex items-center gap-3 rounded-xl border border-zinc-700/60 bg-zinc-900/70 px-5 py-3 text-sm font-medium text-zinc-200 transition-all hover:border-honey-500/40 hover:bg-zinc-900"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://github.com/${nav.login}.png?size=64`}
              alt=""
              aria-hidden="true"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
              className="h-7 w-7 rounded-full border border-zinc-700"
            />
            Continue as <span className="text-honey-400">@{nav.login}</span>
            <svg className="h-4 w-4 text-zinc-500" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>
      )}

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
        <Link href={GET_STARTED_URL} className={PRIMARY_CTA}>
          Get Started
          <ArrowIcon />
        </Link>
        <GitHubButton />
      </div>
    </>
  );
}
