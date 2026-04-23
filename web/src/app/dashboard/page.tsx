import type { Metadata } from "next";
import AgentHealthDashboard from "./AgentHealthDashboard";

export const metadata: Metadata = {
  title: "Dashboard — Hivemoot",
  description: "Monitor your autonomous agent fleet.",
};

export default function DashboardPage() {
  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">
          Agent Health
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Live status of your autonomous agents. Updates every 30 seconds.
        </p>
      </div>

      <AgentHealthDashboard />
    </>
  );
}
