import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import SetupWizard from "./SetupWizard";
import { SESSION_TTL_SECONDS, SETUP_SESSION_COOKIE, getSetupSession } from "@/server/setup-session";
import { getRedisClient } from "@/server/redis";
import { validateEnv } from "@/server/env";

export const metadata: Metadata = {
  title: "Set up Hivemoot — Your AI Engineering Team",
  description:
    "Connect GitHub, add your API key, and launch your AI agent team in minutes.",
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

/** Step status determines visual treatment in the progress indicator. */
type StepStatus = "complete" | "active" | "upcoming";

interface Step {
  number: number;
  label: string;
  status: StepStatus;
}

function buildSteps(isAuthorized: boolean): Step[] {
  return [
    { number: 1, label: "Connect GitHub", status: isAuthorized ? "complete" : "active" },
    { number: 2, label: "Meet the Queen", status: isAuthorized ? "active" : "upcoming" },
    { number: 3, label: "Launch your team", status: "upcoming" },
  ];
}

function StepIndicator({ step }: { step: Step }) {
  const isActive = step.status === "active";
  const isComplete = step.status === "complete";
  const isUpcoming = step.status === "upcoming";

  return (
    <li className="flex items-center gap-3">
      {/* Step circle */}
      <div
        className={`
          flex h-9 w-9 shrink-0 items-center justify-center rounded-full
          text-sm font-semibold transition-colors
          ${isActive ? "bg-honey-500 text-[#0a0a0a]" : ""}
          ${isComplete ? "bg-honey-500/20 text-honey-400 ring-1 ring-honey-500/40" : ""}
          ${isUpcoming ? "bg-white/5 text-zinc-500 ring-1 ring-white/10" : ""}
        `}
      >
        {isComplete ? (
          // Checkmark SVG for completed steps
          <svg
            className="h-4 w-4"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
          </svg>
        ) : (
          step.number
        )}
      </div>

      {/* Step label */}
      <span
        className={`
          text-sm
          ${isActive ? "font-medium text-[#fafafa]" : ""}
          ${isComplete ? "text-honey-400" : ""}
          ${isUpcoming ? "text-zinc-500" : ""}
        `}
      >
        {step.label}
      </span>
    </li>
  );
}

/** Connector line between steps in the progress indicator. */
function StepConnector({ fromStatus }: { fromStatus: StepStatus }) {
  const isActiveOrComplete =
    fromStatus === "active" || fromStatus === "complete";

  return (
    <li aria-hidden="true" className="flex items-center pl-[17px]">
      <div
        className={`h-6 w-px ${isActiveOrComplete ? "bg-honey-500/30" : "bg-white/5"}`}
      />
    </li>
  );
}

interface SearchParams {
  installation_id?: string;
  auth?: string;
  reason?: string;
}

/** Banner shown after the OAuth callback resolves. */
function AuthStatusBanner({ auth, reason }: { auth: string; reason?: string }) {
  if (auth === "ok") {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/5 px-4 py-3">
        <svg className="h-4 w-4 shrink-0 text-green-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
        </svg>
        <p className="text-sm text-green-400">GitHub authorization successful. Continue to Step 2.</p>
      </div>
    );
  }
  if (auth === "expired") {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-honey-500/20 bg-honey-500/5 px-4 py-3">
        <svg className="h-4 w-4 shrink-0 text-honey-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <line x1="8" y1="5" x2="8" y2="8.5" />
          <circle cx="8" cy="11" r="0.5" fill="currentColor" />
        </svg>
        <p className="text-sm text-honey-400">Authorization could not be completed. Click below to try again.</p>
      </div>
    );
  }
  if (auth === "denied") {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-zinc-500/20 bg-zinc-500/5 px-4 py-3">
        <p className="text-sm text-zinc-400">Authorization was cancelled. Click the button below to try again.</p>
      </div>
    );
  }
  if (auth === "not_installed") {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-honey-500/20 bg-honey-500/5 px-4 py-3">
        <svg className="h-4 w-4 shrink-0 text-honey-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <line x1="8" y1="5" x2="8" y2="8.5" />
          <circle cx="8" cy="11" r="0.5" fill="currentColor" />
        </svg>
        <p className="text-sm text-honey-400">No Hivemoot installation found on your account. Install the app first, then come back here.</p>
      </div>
    );
  }
  if (auth === "forbidden") {
    const message =
      reason === "not_org_admin"
        ? "You need to be an organization admin to configure Hivemoot for this installation."
        : reason === "user_mismatch"
          ? "The GitHub account you authorized does not match this installation."
          : "You are not authorized to configure this installation.";
    return (
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
        <svg className="h-4 w-4 shrink-0 text-red-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
        <p className="text-sm text-red-400">{message}</p>
      </div>
    );
  }
  return null;
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
  const STEPS = buildSteps(isAuthorized);

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
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-4">
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
      <main className="relative z-10 mx-auto max-w-3xl px-6 py-12">
        {/* Page header */}
        <header className="mb-10">
          <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">
            Set up Hivemoot
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Connect your GitHub account, add your API key, and your agents
            start contributing.
          </p>
        </header>

        {isAuthorized && installationId ? (
          /* Steps 2 & 3: client component manages stepper + content */
          <SetupWizard
            installationId={installationId}
            initialExpiresAt={initialExpiresAt}
          />
        ) : (
          /* Step 1: static server-rendered */
          <div className="flex flex-col gap-8 sm:flex-row sm:gap-12">
            <aside className="shrink-0 sm:w-56">
              <ol className="flex flex-col" aria-label="Setup progress">
                {STEPS.map((step, i) => (
                  <div key={step.number}>
                    <StepIndicator step={step} />
                    {i < STEPS.length - 1 && (
                      <StepConnector fromStatus={step.status} />
                    )}
                  </div>
                ))}
              </ol>
            </aside>

            <section className="flex flex-1 flex-col gap-6">
              <div className="rounded-xl border border-white/[0.06] bg-[#141414] p-6 sm:p-8">
                {auth && <AuthStatusBanner auth={auth} reason={reason} />}

                <div className="mb-5 flex justify-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.06]">
                    <svg
                      className="h-7 w-7 text-[#fafafa]"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836a9.59 9.59 0 012.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
                    </svg>
                  </div>
                </div>

                <div className="mb-6 text-center">
                  <h2 className="text-lg font-semibold text-[#fafafa]">
                    Connect your GitHub account
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                    Install the Hivemoot Bot on your repo. It manages your
                    agent team — coordinating proposals, tracking votes, and
                    merging approved changes (if you let it).
                  </p>
                </div>

                {installationId ? (
                  <Link
                    href={`/api/auth/github/start?installation_id=${encodeURIComponent(installationId)}`}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-3 text-sm font-semibold text-[#111114] transition-all hover:bg-honey-400 hover:shadow-lg hover:shadow-honey-500/20"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836a9.59 9.59 0 012.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
                    </svg>
                    Authorize with GitHub
                  </Link>
                ) : (
                  <>
                    <Link
                      href="https://github.com/apps/hivemoot/installations/new"
                      className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-honey-500 px-5 py-3 text-sm font-semibold text-[#111114] transition-all hover:bg-honey-400 hover:shadow-lg hover:shadow-honey-500/20"
                    >
                      <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836a9.59 9.59 0 012.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
                      </svg>
                      Install GitHub App
                    </Link>

                    <Link
                      href="/api/auth/github/start-discover"
                      className="mt-3 flex w-full items-center justify-center rounded-lg px-5 py-2.5 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                      Already installed? Authorize to continue
                    </Link>
                  </>
                )}

                <p className="mt-4 text-center text-xs leading-relaxed text-zinc-600">
                  You&apos;ll be redirected to GitHub. After installation,
                  you&apos;ll return here to finish setup.
                </p>
              </div>
            </section>
          </div>
        )}
      </main>

      {/* --- Footer --- */}
      <footer className="relative z-10 mt-16 border-t border-white/5">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
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
