import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Setup error — Hivemoot",
};

interface SearchParams {
  code?: string;
  installation_id?: string;
}

const ERROR_MESSAGES = {
  server_misconfiguration: "The server isn't configured correctly. Contact the site administrator.",
  oauth_state_store_failed:
    "We couldn't start the authorization flow. This is usually a temporary issue.",
  oauth_state_read_failed:
    "We couldn't verify the authorization request. This is usually a temporary issue.",
  setup_session_create_failed:
    "We couldn't create your setup session. This is usually a temporary issue.",
  server_error:
    "Something went wrong on our end. This is usually a temporary issue.",
} as const;

type ErrorCode = keyof typeof ERROR_MESSAGES;

function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_MESSAGES, code);
}

export function normalizeErrorCode(code?: string): ErrorCode {
  if (!code) return "server_error";
  return isErrorCode(code) ? code : "server_error";
}

export function getErrorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code];
}

export default async function SetupErrorPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const code = normalizeErrorCode(params.code);
  const installationId = params.installation_id;

  const retryUrl = installationId
    ? `/setup?installation_id=${encodeURIComponent(installationId)}`
    : "/setup";

  return (
    <div className="relative min-h-screen overflow-hidden">
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
        <div className="flex flex-col gap-8 sm:flex-row sm:gap-12">
          {/* Left: icon column */}
          <aside className="flex shrink-0 items-start justify-center sm:w-56 sm:justify-start sm:pt-1">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-honey-500/10">
              <svg
                className="h-7 w-7 text-honey-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <circle cx="12" cy="16" r="0.5" fill="currentColor" />
              </svg>
            </div>
          </aside>

          {/* Right: content */}
          <section className="flex flex-1 flex-col gap-6">
            <div className="rounded-xl border border-white/[0.06] bg-[#141414] p-6 sm:p-8">
              <h1 className="text-lg font-semibold text-[#fafafa]">
                Something went wrong
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                {getErrorMessage(code)}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-zinc-500">
                Please try again in a moment. If the problem keeps happening,
                check that the Hivemoot Bot is installed on your account.
              </p>

              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <Link
                  href={retryUrl}
                  className="flex items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-3 text-sm font-semibold text-[#111114] transition-all hover:bg-honey-400 hover:shadow-lg hover:shadow-honey-500/20"
                >
                  Try again
                </Link>
                <Link
                  href="/"
                  className="flex items-center justify-center rounded-lg px-5 py-3 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  Back to home
                </Link>
              </div>

              <p className="mt-6 text-xs text-zinc-700">
                Error code: <span className="font-mono">{code}</span>
              </p>
            </div>
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
