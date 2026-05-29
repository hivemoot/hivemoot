"use client";

import { useEffect, useRef, useState } from "react";
import { signOutAndGoHome } from "./auth-nav-helpers";

const SWITCH_ACCOUNT_URL = "/api/auth/github/start-discover";

/**
 * Avatar + @login chip that opens a small menu: switch account (re-run OAuth
 * to pick a different GitHub account — the #167 escape hatch) and sign out.
 *
 * `login` is the public GitHub login. When null (session resolved but no
 * login surfaced) the chip falls back to a neutral "Account" label.
 */
export default function AccountMenu({
  login,
  align = "right",
}: {
  login: string | null;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = login ? `@${login}` : "Account";

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    await signOutAndGoHome();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border border-zinc-700/60 bg-zinc-900/70 px-2.5 py-1.5 text-sm font-medium text-zinc-200 transition-all hover:border-honey-500/40 hover:bg-zinc-900"
      >
        {login && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`https://github.com/${login}.png?size=64`}
            alt=""
            aria-hidden="true"
            className="h-6 w-6 rounded-full border border-zinc-700"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <span className="text-zinc-300">{label}</span>
        <svg
          className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="4 6 8 10 12 6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-50 mt-2 w-48 overflow-hidden rounded-xl border border-zinc-700/60 bg-[#161616] py-1 shadow-xl shadow-black/40 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <a
            role="menuitem"
            href={SWITCH_ACCOUNT_URL}
            className="block px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.04] hover:text-[#fafafa]"
          >
            Switch account
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={signingOut}
            className="block w-full px-4 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-white/[0.04] hover:text-red-300 disabled:opacity-50"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
