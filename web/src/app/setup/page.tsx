import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import SetupLocalFlow from "./SetupLocalFlow";
import SetupWizard from "./SetupWizard";
import { SESSION_TTL_SECONDS, SETUP_SESSION_COOKIE, getSetupSession } from "@/server/setup-session";
import { getRedisClient } from "@/server/redis";
import { validateEnv } from "@/server/env";

export const metadata: Metadata = {
  title: "Set up Hivemoot — Local Agent Runner",
  description:
    "Choose an agent CLI, enable plugins, and generate a local Hivemoot runner config.",
};

/**
 * Inline SVG honeycomb decoration — a cluster of hexagons rendered at low
 * opacity to add subtle texture without importing any external assets.
 */
function HoneycombDecoration({ className }: { className?: string }) {
  // Each hexagon is a regular hexagon (pointy-top) with radius ~20.
  // Offset pattern: even columns shift down by half the row height.
  const hexPoints = (cx: number, cy: number, r: number) => {
    const pts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      pts.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
    }
    return pts.join(" ");
  };

  const r = 18;
  const dx = r * Math.sqrt(3); // horizontal spacing
  const dy = r * 1.5; // vertical spacing

  const hexagons: { cx: number; cy: number }[] = [];
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row < 4; row++) {
      const cx = col * dx;
      const cy = row * dy * 2 + (col % 2 === 1 ? dy : 0);
      hexagons.push({ cx: cx + r, cy: cy + r });
    }
  }

  return (
    <svg
      className={className}
      viewBox="0 0 180 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {hexagons.map((h, i) => (
        <polygon
          key={i}
          points={hexPoints(h.cx, h.cy, r)}
          stroke="currentColor"
          strokeWidth="0.5"
          fill="none"
        />
      ))}
    </svg>
  );
}

interface SearchParams {
  installation_id?: string;
  auth?: string;
  reason?: string;
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const installationId = params.installation_id;
  const auth = params.auth;
  const reason = params.reason;
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SETUP_SESSION_COOKIE)?.value;
  const hasSession = !!sessionToken;

  const isAuthorized = auth === "ok" && hasSession;

  // Resolve actual session expiry from Redis so the client countdown is accurate.
  // Falls back to a freshly-computed window if Redis is unavailable.
  // eslint-disable-next-line react-hooks/purity -- Date.now() is safe in a Next.js async server component
  let initialExpiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  if (isAuthorized && sessionToken) {
    const env = validateEnv();
    if (env.ok && env.config.redisRestUrl && env.config.redisRestToken) {
      const redis = getRedisClient(env.config.redisRestUrl, env.config.redisRestToken);
      const session = await getSetupSession(sessionToken, redis);
      if (session) {
        initialExpiresAt = session.expiresAt;
      }
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* --- Background decorations --- */}
      <HoneycombDecoration className="pointer-events-none absolute -right-8 -top-4 h-44 w-44 text-honey-500/[0.06]" />
      <HoneycombDecoration className="pointer-events-none absolute -left-6 bottom-16 h-36 w-36 text-honey-500/[0.04] rotate-12" />

      {/* Subtle radial glow behind the main content area */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[480px] w-[480px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(245,158,11,0.03) 0%, transparent 70%)",
        }}
        aria-hidden="true"
      />

      {/* --- Navigation --- */}
      <nav className="relative z-10 border-b border-white/5">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-6 py-4">
          <Link
            href="/"
            className="text-sm font-semibold text-honey-500 transition-colors hover:text-honey-400"
          >
            Hivemoot
          </Link>
          <span className="text-zinc-600" aria-hidden="true">
            /
          </span>
          <span className="text-sm text-zinc-400">Setup</span>
        </div>
      </nav>

      {/* --- Main content --- */}
      <main className="relative z-10 mx-auto max-w-5xl px-6 py-12">
        {/* Page header */}
        <header className="mb-10">
          <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">
            Build your local runner
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Pick a runtime, choose plugins, then copy the generated config.
          </p>
        </header>

        {isAuthorized && installationId ? (
          /* Steps 2 & 3: client component manages stepper + content */
          <SetupWizard
            installationId={installationId}
            initialExpiresAt={initialExpiresAt}
          />
        ) : (
          <SetupLocalFlow
            auth={auth}
            reason={reason}
            installationId={installationId}
          />
        )}
      </main>

      {/* --- Footer --- */}
      <footer className="relative z-10 mt-16 border-t border-white/5">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link
            href="/"
            className="group flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <svg
              className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="12" y1="8" x2="4" y2="8" />
              <polyline points="8 4 4 8 8 12" />
            </svg>
            Back to home
          </Link>
          <span className="text-xs text-zinc-700">Hivemoot</span>
        </div>
      </footer>
    </div>
  );
}
