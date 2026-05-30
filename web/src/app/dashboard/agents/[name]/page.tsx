import { Suspense } from "react";
import type { Metadata } from "next";

import { LoadingState } from "@/app/dashboard/ui";
import { AgentDetail } from "./AgentDetail";

export const metadata: Metadata = {
  title: "Agent — Hivemoot",
};

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  // AgentConfigForm (rendered in the Configuration tab) uses useSearchParams,
  // which needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<LoadingState label="Loading agent…" />}>
      <AgentDetail name={name} />
    </Suspense>
  );
}
