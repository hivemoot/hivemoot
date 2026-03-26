"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface RoleEntry {
  name: string;
  description: string;
  instructions: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; role: RoleEntry; fileSha: string; source: string }
  | { kind: "error"; message: string };

type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-4 w-4 animate-spin"} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function RoleEditor({
  owner,
  repo,
  roleName,
}: {
  owner: string;
  repo: string;
  roleName: string;
}) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflictMessage, setConflictMessage] = useState("");
  const [prUrl, setPrUrl] = useState<string | null>(null);

  function loadRoles({ preserveDraft = false } = {}) {
    setLoad({ kind: "loading" });
    fetch(`/api/repos/${owner}/${repo}/roles`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ roles: RoleEntry[]; fileSha: string; source: string }>;
      })
      .then((data) => {
        const role = data.roles.find((r) => r.name === roleName);
        if (!role) throw new Error(`Role "${roleName}" not found in config`);
        setLoad({ kind: "loaded", role, fileSha: data.fileSha, source: data.source });
        if (!preserveDraft) {
          setDescription(role.description);
          setInstructions(role.instructions);
        }
      })
      .catch((err: Error) => setLoad({ kind: "error", message: err.message }));
  }

  useEffect(() => {
    loadRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, roleName]);

  async function handleSave() {
    if (load.kind !== "loaded") return;
    setSaveState("saving");
    try {
      const res = await fetch(`/api/repos/${owner}/${repo}/roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roleName,
          description,
          instructions,
          fileSha: load.fileSha,
        }),
      });

      if (res.status === 409) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setConflictMessage(
          data.message ?? "Config changed on GitHub; reload and reapply your edits.",
        );
        setSaveState("conflict");
        return;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as { prNumber: number; prUrl: string; source: string };
      setPrUrl(data.prUrl);

      // Reload to get the new fileSha from the edit branch.
      const refreshed = await fetch(`/api/repos/${owner}/${repo}/roles`);
      if (refreshed.ok) {
        const refreshData = (await refreshed.json()) as {
          roles: RoleEntry[];
          fileSha: string;
          source: string;
        };
        const refreshedRole = refreshData.roles.find((r) => r.name === roleName);
        if (refreshedRole) {
          setLoad({
            kind: "loaded",
            role: refreshedRole,
            fileSha: refreshData.fileSha,
            source: refreshData.source,
          });
        }
      }

      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 4000);
    } catch {
      setSaveState("error");
    }
  }

  function handleConflictReload() {
    setSaveState("idle");
    setConflictMessage("");
    // Refresh fileSha from GitHub while keeping the user's draft edits.
    loadRoles({ preserveDraft: true });
  }

  if (load.kind === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        <SpinnerIcon />
        <span>Loading…</span>
      </div>
    );
  }

  if (load.kind === "error") {
    return <p className="text-sm text-red-400">{load.message}</p>;
  }

  const { source } = load;
  const sourceBadge =
    source === "main"
      ? "Editing: main"
      : `Editing: ${source.replace("pending-pr:", "pending PR #")}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href={`/dashboard/fleet/${owner}/${repo}/roles`}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          ← Roles
        </Link>
        <span className="inline-flex items-center rounded-full border border-white/10 bg-zinc-900 px-2.5 py-0.5 text-xs text-zinc-400">
          {sourceBadge}
        </span>
      </div>

      <div className="space-y-4">
        <div>
          <label
            htmlFor="role-description"
            className="block text-xs font-medium text-zinc-400 mb-1.5"
          >
            Description
          </label>
          <input
            id="role-description"
            type="text"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              if (saveState === "saved") setSaveState("idle");
            }}
            placeholder="Short description of this role"
            className="w-full rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-[#fafafa] placeholder:text-zinc-600 focus:border-honey-500 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="role-instructions"
            className="block text-xs font-medium text-zinc-400 mb-1.5"
          >
            Instructions
          </label>
          <textarea
            id="role-instructions"
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
              if (saveState === "saved") setSaveState("idle");
            }}
            rows={14}
            placeholder="Role instructions passed to the agent at runtime"
            className="w-full rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-sm font-mono text-[#fafafa] placeholder:text-zinc-600 focus:border-honey-500 focus:outline-none resize-y"
          />
        </div>
      </div>

      {saveState === "conflict" && (
        <div className="rounded-md border border-amber-500/30 bg-amber-900/20 px-4 py-3 space-y-2">
          <p className="text-xs text-amber-300">{conflictMessage}</p>
          <p className="text-xs text-zinc-400">
            Your edits are still in the fields above. After reloading the latest config, review
            any differences and save again.
          </p>
          <button
            onClick={handleConflictReload}
            className="text-xs text-amber-400 underline hover:text-amber-300 transition-colors"
          >
            Reload latest config
          </button>
        </div>
      )}

      <div className="flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={saveState === "saving"}
          className="rounded-md bg-honey-500 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-honey-400 disabled:opacity-50 transition-colors"
        >
          {saveState === "saving" ? (
            <span className="flex items-center gap-2">
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </span>
          ) : (
            "Save via PR"
          )}
        </button>

        {saveState === "saved" && prUrl && (
          <p className="text-xs text-emerald-400">
            Saved.{" "}
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-emerald-300"
            >
              View PR
            </a>
          </p>
        )}
        {saveState === "saved" && !prUrl && (
          <p className="text-xs text-emerald-400">Saved.</p>
        )}
        {saveState === "error" && (
          <p className="text-xs text-red-400">Save failed. Please try again.</p>
        )}
      </div>
    </div>
  );
}
