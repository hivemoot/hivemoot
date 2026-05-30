import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";

import { LoadingState, PageHeader } from "@/app/dashboard/ui";
import { AgentConfigForm } from "../AgentConfigForm";
import { ArrowLeftIcon } from "../shared";

export const metadata: Metadata = {
  title: "New Agent — Hivemoot",
  description: "Register a new autonomous agent.",
};

export default function NewAgentPage() {
  return (
    <>
      <Link
        href="/dashboard/agents"
        className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-300"
      >
        <ArrowLeftIcon className="h-3.5 w-3.5" />
        Back to agents
      </Link>

      <PageHeader
        title="New Agent"
        description="Register an agent, pick its skills and engine, and wire up the triggers that activate it."
      />

      {/* AgentConfigForm reads ?name=&repo= (adopt flow) via useSearchParams,
          which requires a Suspense boundary in the App Router. */}
      <Suspense fallback={<LoadingState label="Loading…" />}>
        <AgentConfigForm mode="create" />
      </Suspense>
    </>
  );
}
