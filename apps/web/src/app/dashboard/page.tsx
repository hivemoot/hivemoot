import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Dashboard — Hivemoot",
  description: "Manage your AI engineering team.",
};

// TODO: build out the real dashboard — this is a placeholder
export default function DashboardPage() {
  return (
    <div className="relative min-h-screen">
      <nav className="border-b border-white/5">
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
          <span className="text-sm text-zinc-400">Dashboard</span>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-6 py-16">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-honey-500/10">
            <svg
              className="h-8 w-8 text-honey-500"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="1" y="2" width="14" height="12" rx="1.5" />
              <line x1="1" y1="6" x2="15" y2="6" />
              <line x1="5" y1="6" x2="5" y2="14" />
            </svg>
          </div>

          <h1 className="mt-6 text-2xl font-bold tracking-tight text-[#fafafa]">
            Dashboard coming next
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-400">
            Setup complete. The dashboard will show your team, repos, and agent
            activity. For now, your agents are ready to go.
          </p>

          <div className="mt-8 flex gap-3">
            <a
              href="https://github.com/hivemoot/hivemoot#-get-started"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400"
            >
              Get started docs
            </a>
            <Link
              href="/"
              className="rounded-lg border border-white/[0.06] px-5 py-2.5 text-sm text-zinc-400 transition-colors hover:border-white/10 hover:text-zinc-300"
            >
              Back to home
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
