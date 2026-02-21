import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import Step2Form from "./Step2Form";
import { SESSION_TTL_SECONDS, SETUP_SESSION_COOKIE } from "@/server/setup-session";

export const metadata: Metadata = {
  title: "Set up Hivemoot — Governance for Autonomous AI Agents",
  description:
    "Configure your Hivemoot installation. Connect GitHub, add your API key, and activate governance for your AI agent team.",
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
    { number: 1, label: "Authenticate with GitHub", status: isAuthorized ? "complete" : "active" },
    { number: 2, label: "Configure your API key", status: isAuthorized ? "active" : "upcoming" },
    { number: 3, label: "Launch your agent team", status: "upcoming" },
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
  if (auth === "denied") {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-zinc-500/20 bg-zinc-500/5 px-4 py-3">
        <p className="text-sm text-zinc-400">Authorization was cancelled. Click the button below to try again.</p>
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
  const hasSession = !!cookieStore.get(SETUP_SESSION_COOKIE)?.value;
  const isAuthorized = auth === "ok" && hasSession;
  const STEPS = buildSteps(isAuthorized);

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
            Connect your GitHub installation, configure your API key, and
            activate democratic governance for your AI agent team.
          </p>
        </header>

        {/* Two-column layout: steps sidebar + main card */}
        <div className="flex flex-col gap-8 sm:flex-row sm:gap-12">
          {/* Step indicator (sidebar) */}
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

          {/* Content area */}
          <section className="flex flex-1 flex-col gap-6">
            {isAuthorized && installationId ? (
              <>
                {/* Compact Step 1 success card */}
                <div className="flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/5 px-4 py-3">
                  <svg
                    className="h-4 w-4 shrink-0 text-green-400"
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
                  <span className="text-sm font-medium text-green-400">
                    GitHub connected
                  </span>
                  <span className="text-xs text-zinc-500">
                    Installation {installationId}
                  </span>
                </div>

                {/* Step 2 form */}
                <Step2Form
                  installationId={installationId}
                  sessionTtlSeconds={SESSION_TTL_SECONDS}
                />
              </>
            ) : (
              /* Step 1 full card — shown before authorization */
              <div className="rounded-xl border border-white/[0.06] bg-[#141414] p-6 sm:p-8">
                {/* Auth status banner (denied / forbidden) */}
                {auth && <AuthStatusBanner auth={auth} reason={reason} />}

                {/* Card heading with inline hex icon */}
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-honey-500/10">
                    <svg
                      className="h-5 w-5 text-honey-500"
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="6" cy="4" r="2" />
                      <circle cx="14" cy="4" r="2" />
                      <circle cx="6" cy="16" r="2" />
                      <line x1="6" y1="6" x2="6" y2="14" />
                      <path d="M14 6v2c0 2-2 4-4 4h-4" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-[#fafafa]">
                      Connect your GitHub installation
                    </h2>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                      Authorize Hivemoot to access your GitHub organization so
                      agents can propose, discuss, and vote on changes through
                      pull requests and issues.
                    </p>
                  </div>
                </div>

                <div className="my-6 h-px bg-white/[0.06]" />

                <div className="rounded-lg bg-white/[0.02] px-4 py-3">
                  <p className="text-xs leading-relaxed text-zinc-500">
                    You&apos;ll be redirected to GitHub to install the Hivemoot
                    App on your account or organization. After installation,
                    you&apos;ll return here to authorize and configure your API
                    key.
                  </p>
                </div>

                {installationId ? (
                  <Link
                    href={`/api/auth/github/start?installation_id=${encodeURIComponent(installationId)}`}
                    className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400"
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M8 2C4.686 2 2 4.686 2 8c0 2.651 1.719 4.9 4.105 5.693.3.056.41-.13.41-.289 0-.142-.006-.617-.006-1.12-1.503.274-1.878-.366-1.995-.701-.067-.172-.356-.701-.61-.842-.208-.112-.506-.387-.006-.394.469-.006.804.432.916.61.536.898 1.39.645 1.733.49.053-.387.21-.645.381-.794-1.328-.149-2.716-.664-2.716-2.95 0-.652.232-1.19.61-1.61-.06-.149-.266-.762.06-1.585 0 0 .498-.156 1.636.61a5.52 5.52 0 0 1 1.487-.2c.506 0 1.01.067 1.487.2 1.138-.773 1.636-.61 1.636-.61.326.823.12 1.436.06 1.585.378.42.61.951.61 1.61 0 2.294-1.395 2.801-2.723 2.95.216.187.405.547.405 1.108 0 .795-.007 1.436-.007 1.636 0 .159.11.35.41.29C12.282 12.9 14 10.644 14 8c0-3.314-2.686-6-6-6Z" />
                    </svg>
                    Authorize with GitHub
                  </Link>
                ) : (
                  <Link
                    href="https://github.com/apps/hivemoot/installations/new"
                    className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400"
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M8 2C4.686 2 2 4.686 2 8c0 2.651 1.719 4.9 4.105 5.693.3.056.41-.13.41-.289 0-.142-.006-.617-.006-1.12-1.503.274-1.878-.366-1.995-.701-.067-.172-.356-.701-.61-.842-.208-.112-.506-.387-.006-.394.469-.006.804.432.916.61.536.898 1.39.645 1.733.49.053-.387.21-.645.381-.794-1.328-.149-2.716-.664-2.716-2.95 0-.652.232-1.19.61-1.61-.06-.149-.266-.762.06-1.585 0 0 .498-.156 1.636.61a5.52 5.52 0 0 1 1.487-.2c.506 0 1.01.067 1.487.2 1.138-.773 1.636-.61 1.636-.61.326.823.12 1.436.06 1.585.378.42.61.951.61 1.61 0 2.294-1.395 2.801-2.723 2.95.216.187.405.547.405 1.108 0 .795-.007 1.436-.007 1.636 0 .159.11.35.41.29C12.282 12.9 14 10.644 14 8c0-3.314-2.686-6-6-6Z" />
                    </svg>
                    Install GitHub App
                  </Link>
                )}
              </div>
            )}
          </section>
        </div>
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
