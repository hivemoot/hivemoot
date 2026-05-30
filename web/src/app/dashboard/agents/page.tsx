import type { Metadata } from "next";
import { ButtonLink, PageHeader } from "@/app/dashboard/ui";
import { ConnectRepoCta, sessionHasInstallation } from "./install-gate";
import { AgentsList } from "./AgentsList";
import { PlusIcon } from "./shared";

export const metadata: Metadata = {
  title: "Agents — Hivemoot",
  description: "Register, configure, and monitor your autonomous agents.",
};

export default async function AgentsPage() {
  const hasInstallation = await sessionHasInstallation();

  if (!hasInstallation) {
    return (
      <>
        <PageHeader
          title="Agents"
          description="One step to unlock the dashboard."
        />
        <ConnectRepoCta />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Agents"
        description="Register, configure, and monitor your autonomous agents."
        actions={
          <ButtonLink href="/dashboard/agents/new" variant="primary" size="md">
            <PlusIcon className="h-4 w-4" />
            New Agent
          </ButtonLink>
        }
      />
      <AgentsList />
    </>
  );
}
