import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getRedisClient } from "@/server/redis";
import { validateEnv } from "@/server/env";
import {
  getSetupSession,
  isSessionFresh,
  SETUP_SESSION_COOKIE,
} from "@/server/setup-session";
import CredentialsPanel from "./CredentialsPanel";

export const metadata: Metadata = {
  title: "Credentials — Hivemoot Dashboard",
  description: "Manage LLM API keys and agent tokens.",
};

export default async function CredentialsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SETUP_SESSION_COOKIE)?.value;

  let fresh = false;
  let reAuthUrl = "/api/auth/github/start-discover?force=1&next=/dashboard/credentials";
  if (token) {
    const env = validateEnv();
    if (env.ok && env.config.redisRestUrl && env.config.redisRestToken) {
      try {
        const redis = getRedisClient(env.config.redisRestUrl, env.config.redisRestToken);
        const session = await getSetupSession(token, redis);
        if (session) {
          fresh = isSessionFresh(session);
          // Route re-auth through /start with the known installationId so the
          // callback skips discovery and stays pinned to the current installation.
          // Using start-discover would pick installations[0], silently switching
          // multi-install users to the wrong installation.
          reAuthUrl = `/api/auth/github/start?installation_id=${encodeURIComponent(session.installationId)}&next=/dashboard/credentials`;
        }
      } catch {
        // Treat as stale on Redis error. Fall back to the discovery path.
      }
    }
  }

  if (!fresh) {
    return (
      <>
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">
            Credentials
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Manage your LLM API key and agent authentication token.
          </p>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
          <p className="text-sm text-zinc-300 mb-4">
            Re-authenticate to access your credentials. This page requires a fresh login
            (within the last 15 minutes) for security.
          </p>
          <a
            href={reAuthUrl}
            className="inline-flex items-center gap-2 rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400 transition-colors"
          >
            Re-authenticate with GitHub
          </a>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">
          Credentials
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Manage your LLM API key and agent authentication token.
        </p>
      </div>

      <CredentialsPanel />
    </>
  );
}
