import { INSTALL_APP_URL } from "@/lib/constants";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import AgentHealthDashboard from "./AgentHealthDashboard";
import { PageHeader } from "@/app/dashboard/ui";
import { SETUP_SESSION_COOKIE, getSetupSession } from "@/server/setup-session";
import { getRedisClient } from "@/server/redis";
import { validateEnv } from "@/server/env";

export const metadata: Metadata = {
  title: "Dashboard — Hivemoot",
  description: "Monitor your autonomous agent fleet.",
};


async function sessionHasInstallation(): Promise<boolean> {
  // Default true so transient infra errors (Redis down, env unreadable) still
  // render the normal dashboard shell. Client-side API calls surface the real
  // error instead of the server component crashing the page.
  const cookieStore = await cookies();
  const token = cookieStore.get(SETUP_SESSION_COOKIE)?.value;
  if (!token) return true;

  const env = validateEnv();
  if (!env.ok || !env.config.redisRestUrl || !env.config.redisRestToken) {
    return true;
  }

  try {
    const redis = getRedisClient(env.config.redisRestUrl, env.config.redisRestToken);
    const session = await getSetupSession(token, redis);
    if (!session) return true;
    return session.installationId !== null;
  } catch (err) {
    console.warn("[dashboard] Failed to resolve session; rendering normal shell", { error: err });
    return true;
  }
}

function ConnectRepoCta() {
  return (
    <div className="rounded-2xl border border-honey-500/20 bg-honey-500/5 p-8 sm:p-10">
      <div className="flex flex-col items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-honey-500/10 text-honey-400">
          <svg
            className="h-6 w-6"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[#fafafa]">
            Connect the Queen to a repo
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">
            You&apos;re signed in, but the Hivemoot Bot isn&apos;t installed on
            any of your repos yet. Install it on a repo to unlock governance
            features — agent roles, task dispatch, BYOK, and the full
            dashboard.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href={INSTALL_APP_URL}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#111114] transition-all hover:bg-honey-400 hover:shadow-lg hover:shadow-honey-500/20"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836a9.59 9.59 0 012.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
            </svg>
            Install on a repo
          </Link>
          <Link
            href="https://github.com/hivemoot/hivemoot#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-lg border border-white/10 px-5 py-2.5 text-sm text-zinc-300 transition-colors hover:border-white/20 hover:text-[#fafafa]"
          >
            Read the docs
          </Link>
        </div>
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  const hasInstallation = await sessionHasInstallation();

  if (!hasInstallation) {
    return (
      <>
        <PageHeader
          title="Welcome to Hivemoot"
          description="One step to unlock the dashboard."
        />

        <ConnectRepoCta />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Agent Health"
        description="Live status of your autonomous agents. Updates every 30 seconds."
      />

      <AgentHealthDashboard />
    </>
  );
}
