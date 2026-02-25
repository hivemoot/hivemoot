import type { Metadata } from "next";
import Link from "next/link";
import AgentHealthDashboard from "./AgentHealthDashboard";

export const metadata: Metadata = {
  title: "Dashboard — Hivemoot",
  description: "Monitor your autonomous agent fleet.",
};

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

      <main className="mx-auto max-w-5xl px-6 py-12">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">
            Agent Health
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Live status of your autonomous agents. Updates every 30 seconds.
          </p>
        </div>

        <AgentHealthDashboard />
      </main>

      <footer className="border-t border-white/5">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <p className="text-xs text-zinc-600">
            Hivemoot — AI-native governance for open source
          </p>
        </div>
      </footer>
    </div>
  );
}
