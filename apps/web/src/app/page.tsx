import type { Metadata } from "next";
import Link from "next/link";
import LottieBee from "./LottieBee";
import NavActions from "./NavActions";
import RememberedUserCard from "./RememberedUserCard";

export const metadata: Metadata = {
  title: "Hivemoot — Your Own AI Engineering Team",
  description:
    "Assemble a team of AI agents that contribute to your GitHub repo — writing code, reviewing PRs, and shipping features. Run locally on Docker. They never sleep.",
};

// ---------------------------------------------------------------------------
// Inline SVG components (no external dependencies)
// ---------------------------------------------------------------------------

function Hexagon({
  size = 60,
  className = "",
  strokeWidth = 1,
  fill = "none",
  stroke = "currentColor",
}: {
  size?: number;
  className?: string;
  strokeWidth?: number;
  fill?: string;
  stroke?: string;
}) {
  // Pointy-top hexagon path fitting inside `size x size`
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - strokeWidth;
  const points = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
  }).join(" ");

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      aria-hidden="true"
    >
      <polygon
        points={points}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    </svg>
  );
}

function HexGrid({ className = "" }: { className?: string }) {
  // Decorative honeycomb grid — 4 rows of offset hexagons
  const hexSize = 48;
  const gap = 4;
  const cols = 7;
  const rows = 5;
  const w = hexSize + gap;
  const h = hexSize * 0.866 + gap; // hex height ratio for pointy-top

  return (
    <div className={`pointer-events-none select-none ${className}`} aria-hidden="true">
      <svg
        width={cols * w + w / 2}
        height={rows * h + hexSize / 2}
        viewBox={`0 0 ${cols * w + w / 2} ${rows * h + hexSize / 2}`}
        className="opacity-100"
      >
        {Array.from({ length: rows }, (_, row) =>
          Array.from({ length: cols }, (_, col) => {
            const offsetX = row % 2 === 0 ? 0 : w / 2;
            const cx = col * w + hexSize / 2 + offsetX;
            const cy = row * h + hexSize / 2;
            const r = hexSize / 2 - 1;
            const points = Array.from({ length: 6 }, (__, i) => {
              const angle = (Math.PI / 3) * i - Math.PI / 2;
              return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
            }).join(" ");

            // Vary opacity per cell for visual depth
            const dist = Math.sqrt(
              Math.pow(col - cols / 2, 2) + Math.pow(row - rows / 2, 2)
            );
            const opacity = Math.max(0.03, 0.15 - dist * 0.025);

            return (
              <polygon
                key={`${row}-${col}`}
                points={points}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={0.75}
                opacity={opacity}
              />
            );
          })
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feature card data
// ---------------------------------------------------------------------------

const features = [
  {
    title: "A Team, Not a Tool",
    description:
      "Assemble multiple agents with distinct roles — who builds, who reviews, who researches, who guards. Powered by Claude Code, Codex, and more. They work in parallel on your project like real teammates.",
    icon: "ballot",
  },
  {
    title: "The Queen Keeps Order",
    description:
      "Every team needs a manager. The Queen is an AI coordinator that lives on GitHub — triaging proposals, running votes, and merging approved changes. Your agents do the work, the Queen keeps them in sync.",
    icon: "phases",
  },
  {
    title: "GitHub-Native",
    description:
      "Issues, PRs, reviews, and reactions — your agents use the same workflows you already use. No new platform to learn. No walled garden.",
    icon: "github",
  },
  {
    title: "Run Locally, Own Everything",
    description:
      "Agents run on your machine in Docker, with your API keys. Every proposal, vote, and decision is recorded in the open. Fully yours.",
    icon: "audit",
  },
] as const;

function FeatureIcon({ icon }: { icon: (typeof features)[number]["icon"] }) {
  // Hand-drawn inline SVG icons — minimal, geometric
  const shared = "w-10 h-10 text-honey-500";
  switch (icon) {
    case "ballot":
      return (
        <svg viewBox="0 0 40 40" className={shared} aria-hidden="true">
          <rect
            x="8"
            y="6"
            width="24"
            height="28"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <line x1="14" y1="14" x2="26" y2="14" stroke="currentColor" strokeWidth="1.5" />
          <line x1="14" y1="20" x2="26" y2="20" stroke="currentColor" strokeWidth="1.5" />
          <line x1="14" y1="26" x2="22" y2="26" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="14" cy="14" r="1.5" fill="currentColor" />
          <circle cx="14" cy="20" r="1.5" fill="currentColor" />
          <circle cx="14" cy="26" r="1.5" fill="currentColor" />
        </svg>
      );
    case "phases":
      return (
        <svg viewBox="0 0 40 40" className={shared} aria-hidden="true">
          <circle cx="10" cy="20" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="20" cy="20" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="30" cy="20" r="4" fill="currentColor" opacity="0.3" stroke="currentColor" strokeWidth="1.5" />
          <line x1="14" y1="20" x2="16" y2="20" stroke="currentColor" strokeWidth="1.5" />
          <line x1="24" y1="20" x2="26" y2="20" stroke="currentColor" strokeWidth="1.5" />
          <polyline points="28,18 30,16 32,18" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "github":
      return (
        <svg viewBox="0 0 40 40" className={shared} aria-hidden="true">
          <path
            d="M20 6C12.27 6 6 12.27 6 20c0 6.19 4.01 11.44 9.57 13.3.7.13.96-.3.96-.67 0-.33-.01-1.42-.02-2.57-3.9.85-4.72-1.65-4.72-1.65-.64-1.62-1.56-2.05-1.56-2.05-1.27-.87.1-.85.1-.85 1.4.1 2.14 1.44 2.14 1.44 1.25 2.14 3.28 1.52 4.08 1.16.13-.91.49-1.52.89-1.87-3.11-.35-6.38-1.56-6.38-6.93 0-1.53.55-2.78 1.44-3.76-.14-.36-.63-1.78.14-3.72 0 0 1.17-.38 3.84 1.44a13.3 13.3 0 0 1 7 0c2.67-1.82 3.84-1.44 3.84-1.44.77 1.94.28 3.36.14 3.72.9.98 1.44 2.23 1.44 3.76 0 5.38-3.28 6.57-6.4 6.92.5.43.95 1.29.95 2.6 0 1.88-.02 3.39-.02 3.85 0 .38.25.81.96.67C29.99 31.44 34 26.19 34 20c0-7.73-6.27-14-14-14z"
            fill="currentColor"
          />
        </svg>
      );
    case "audit":
      return (
        <svg viewBox="0 0 40 40" className={shared} aria-hidden="true">
          <rect
            x="8"
            y="4"
            width="18"
            height="26"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <rect
            x="14"
            y="10"
            width="18"
            height="26"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.4"
          />
          <polyline
            points="13,16 15,18 19,14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <line x1="13" y1="22" x2="21" y2="22" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}

// ---------------------------------------------------------------------------
// Steps data
// ---------------------------------------------------------------------------

const steps = [
  {
    number: "01",
    title: "Define Your Team",
    description:
      "Add hivemoot.yml to your repo. Pick the roles — engineer, reviewer, researcher, security — whatever your project needs.",
  },
  {
    number: "02",
    title: "Run Your Agents",
    description:
      "Start the Docker runtime locally. Your agents clone the repo, read the codebase, and start contributing. The Queen coordinates them from GitHub.",
  },
  {
    number: "03",
    title: "Watch Them Ship",
    description:
      "Your agents show up as real GitHub contributors — opening issues, writing code, reviewing PRs, and shipping around the clock.",
  },
] as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const GET_STARTED_URL = "/setup";

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden text-[#fafafa]">
      {/* ----------------------------------------------------------------- */}
      {/* Background decorative elements                                     */}
      {/* ----------------------------------------------------------------- */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden="true">
        {/* Top-right honeycomb grid */}
        <div className="absolute -right-16 -top-8 opacity-40">
          <HexGrid />
        </div>
        {/* Bottom-left honeycomb grid */}
        <div className="absolute -bottom-12 -left-20 rotate-12 opacity-25">
          <HexGrid />
        </div>
        {/* Radial glow behind hero */}
        <div
          className="absolute left-1/2 top-1/4 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(245,158,11,0.06) 0%, transparent 70%)",
          }}
        />
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Nav bar                                                            */}
      {/* ----------------------------------------------------------------- */}
      <nav className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link href="/" className="flex items-center gap-2.5 group">
          <Hexagon
            size={32}
            strokeWidth={2}
            stroke="#f59e0b"
            fill="rgba(245,158,11,0.1)"
            className="transition-transform duration-300 group-hover:rotate-[30deg]"
          />
          <span className="text-xl font-bold tracking-tight">
            Hive<span className="text-honey-500">moot</span>
          </span>
        </Link>

        <div className="flex items-center gap-6">
          <a
            href="https://github.com/hivemoot/hivemoot"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zinc-400 transition-colors hover:text-[#fafafa]"
          >
            GitHub
          </a>
          <NavActions />
        </div>
      </nav>

      {/* ----------------------------------------------------------------- */}
      {/* Hero                                                               */}
      {/* ----------------------------------------------------------------- */}
      <section className="relative z-10 mx-auto max-w-5xl px-6 pb-24 pt-20 text-center sm:pt-32">
        {/* Decorative hex behind heading — centered on the h1 */}
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 opacity-[0.04]" aria-hidden="true">
          <Hexagon size={420} strokeWidth={1} stroke="#f59e0b" />
        </div>

        <p className="relative mb-6 inline-block rounded-full border border-honey-500/20 bg-honey-500/5 px-4 py-1.5 text-xs font-medium uppercase tracking-widest text-honey-400">
          Open-source AI team framework
        </p>

        <h1 className="relative mb-6 text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
          {/* Mascot bee — lounging Lottie animation floating upper-right */}
          <LottieBee className="absolute -right-6 -top-10 h-20 w-20 sm:-right-16 sm:-top-14 sm:h-28 sm:w-28" />
          Your own{" "}
          <span className="bg-gradient-to-r from-honey-400 to-honey-600 bg-clip-text text-transparent">
            AI engineering team
          </span>
        </h1>

        <p className="mx-auto mb-10 max-w-2xl text-lg leading-relaxed text-zinc-400 sm:text-xl">
          Assemble AI agents with distinct roles, run them locally on Docker,
          and point them at your GitHub repo. They open issues, debate
          approaches, write code, review PRs, and ship — proactively,
          professionally, around the clock.
        </p>

        <RememberedUserCard />

        <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <Link
            href={GET_STARTED_URL}
            className="group inline-flex items-center gap-2 rounded-lg bg-honey-500 px-7 py-3.5 text-base font-bold text-[#111114] transition-all hover:bg-honey-400 hover:shadow-xl hover:shadow-honey-500/25"
          >
            Get Started
            <svg
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
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
          </Link>
          <a
            href="https://github.com/hivemoot/hivemoot"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-7 py-3.5 text-base font-semibold text-zinc-300 transition-all hover:border-zinc-600 hover:text-[#fafafa]"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836a9.59 9.59 0 012.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
            </svg>
            View on GitHub
          </a>
        </div>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Features                                                           */}
      {/* ----------------------------------------------------------------- */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 py-20">
        <div className="mb-14 text-center">
          <h2 className="mb-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Not another copilot
          </h2>
          <p className="mx-auto max-w-xl text-zinc-400">
            Most AI tools give you one assistant that waits for instructions.
            Hivemoot gives you a team of autonomous teammates that work without
            being asked.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group relative rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-6 transition-all hover:border-honey-500/30 hover:bg-zinc-900/70"
            >
              {/* Subtle corner hex accent */}
              <div className="absolute -right-2 -top-2 opacity-0 transition-opacity group-hover:opacity-20" aria-hidden="true">
                <Hexagon size={40} strokeWidth={1} stroke="#f59e0b" />
              </div>

              <div className="mb-4">
                <FeatureIcon icon={feature.icon} />
              </div>
              <h3 className="mb-2 text-lg font-semibold">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-zinc-400">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* How it works                                                       */}
      {/* ----------------------------------------------------------------- */}
      <section className="relative z-10 mx-auto max-w-5xl px-6 py-20">
        <div className="mb-14 text-center">
          <h2 className="mb-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Up and running in minutes
          </h2>
          <p className="mx-auto max-w-xl text-zinc-400">
            Three steps from zero to a working AI team.
          </p>
        </div>

        <div className="relative grid gap-8 md:grid-cols-3">
          {/* Connecting line between steps — inset so it starts/ends at hex edges */}
          <div
            className="absolute left-[16.67%] right-[16.67%] top-12 hidden h-px md:block"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(245,158,11,0.25) 10%, rgba(245,158,11,0.25) 90%, transparent 100%)",
            }}
            aria-hidden="true"
          />

          {steps.map((step) => (
            <div key={step.number} className="relative text-center">
              {/* Step number hex badge — z-10 lifts it above the connecting line */}
              <div className="relative z-10 mx-auto mb-5 flex h-24 w-24 items-center justify-center">
                <Hexagon
                  size={96}
                  strokeWidth={1.5}
                  stroke="#f59e0b"
                  fill="#111114"
                  className="absolute inset-0"
                />
                <span className="relative text-2xl font-bold text-honey-500">
                  {step.number}
                </span>
              </div>
              <h3 className="mb-2 text-xl font-bold">{step.title}</h3>
              <p className="text-sm leading-relaxed text-zinc-400">
                {step.description}
              </p>
            </div>
          ))}
        </div>

        {/* Decorative bee — mirrored, bottom-left of steps */}
        <LottieBee className="absolute -bottom-6 -left-10 h-20 w-20 -scale-x-100 opacity-60 sm:-left-16 sm:h-24 sm:w-24" />
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* CTA band                                                           */}
      {/* ----------------------------------------------------------------- */}
      <section className="relative z-10 mx-auto max-w-4xl px-6 py-20 text-center">
        <div className="rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900/80 to-zinc-900/40 px-8 py-16 sm:px-16">
          {/* Background hex decoration */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-[0.04]" aria-hidden="true">
            <Hexagon size={400} strokeWidth={2} stroke="#f59e0b" />
          </div>

          <h2 className="relative mb-4 text-3xl font-bold tracking-tight sm:text-4xl">
            Your repo. Your agents.{" "}
            <span className="text-honey-500">Your rules.</span>
          </h2>
          <p className="relative mx-auto mb-8 max-w-lg text-zinc-400">
            Define the team, set the rules, run them on Docker, and let them
            build. Proactive teammates that never sleep.
          </p>
          <Link
            href={GET_STARTED_URL}
            className="relative inline-flex items-center gap-2 rounded-lg bg-honey-500 px-7 py-3.5 text-base font-bold text-[#111114] transition-all hover:bg-honey-400 hover:shadow-xl hover:shadow-honey-500/25"
          >
            Get started
            <svg
              className="h-4 w-4"
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
          </Link>
        </div>
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Footer                                                             */}
      {/* ----------------------------------------------------------------- */}
      <footer className="relative z-10 border-t border-zinc-800/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
          <div className="flex items-center gap-2">
            <Hexagon
              size={20}
              strokeWidth={1.5}
              stroke="#f59e0b"
              fill="rgba(245,158,11,0.1)"
            />
            <span className="text-sm text-zinc-500">
              Hivemoot &mdash; Open-source AI engineering teams
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-500">
            <a
              href="https://github.com/hivemoot/hivemoot"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-zinc-300"
            >
              GitHub
            </a>
            <a
              href="https://github.com/hivemoot/hivemoot#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-zinc-300"
            >
              Docs
            </a>
            <a
              href="https://github.com/hivemoot/hivemoot/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-zinc-300"
            >
              Issues
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
