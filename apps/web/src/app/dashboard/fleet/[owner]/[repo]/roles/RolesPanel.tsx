"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface RoleEntry {
  name: string;
  description: string;
  instructions: string;
}

type RolesState =
  | { kind: "loading" }
  | { kind: "data"; roles: RoleEntry[]; source: string }
  | { kind: "error"; message: string };

function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-4 w-4"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11.5 2.5 13.5 4.5 5 13H3v-2L11.5 2.5z" />
    </svg>
  );
}

export function RolesPanel({ owner, repo }: { owner: string; repo: string }) {
  const [state, setState] = useState<RolesState>({ kind: "loading" });

  useEffect(() => {
    fetch(`/api/repos/${owner}/${repo}/roles`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ roles: RoleEntry[]; source: string }>;
      })
      .then((data) => setState({ kind: "data", roles: data.roles, source: data.source }))
      .catch((err: Error) => setState({ kind: "error", message: err.message }));
  }, [owner, repo]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        <SpinnerIcon />
        <span>Loading roles…</span>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <p className="text-sm text-red-400">Failed to load roles: {state.message}</p>
    );
  }

  const { roles, source } = state;
  const sourceBadge =
    source === "main"
      ? "Editing: main"
      : `Editing: ${source.replace("pending-pr:", "pending PR #")}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-white/10 bg-zinc-900 px-2.5 py-0.5 text-xs text-zinc-400">
          {sourceBadge}
        </span>
      </div>

      {roles.length === 0 ? (
        <p className="text-sm text-zinc-500">No roles found in .github/hivemoot.yml.</p>
      ) : (
        <ul className="divide-y divide-white/5 rounded-lg border border-white/5">
          {roles.map((role) => (
            <li key={role.name}>
              <Link
                href={`/dashboard/fleet/${owner}/${repo}/roles/${role.name}`}
                className="group flex items-center justify-between px-4 py-4 hover:bg-white/[0.02] transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#fafafa]">{role.name}</p>
                  {role.description && (
                    <p className="mt-0.5 truncate text-xs text-zinc-400">{role.description}</p>
                  )}
                </div>
                <PencilIcon className="ml-4 h-3.5 w-3.5 flex-shrink-0 text-zinc-600 group-hover:text-honey-500 transition-colors" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
