import type { Metadata } from "next";
import { RolesPanel } from "./RolesPanel";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}): Promise<Metadata> {
  const { owner, repo } = await params;
  return {
    title: `Roles — ${owner}/${repo} — Hivemoot`,
    description: `Edit agent role instructions for ${owner}/${repo}.`,
  };
}

export default async function RolesPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;

  return (
    <>
      <div className="mb-8">
        <p className="text-xs text-zinc-500 mb-1">
          {owner}/{repo}
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">Agent Roles</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Edit agent personalities and instructions. Changes open a PR in the repository for review.
        </p>
      </div>

      <RolesPanel owner={owner} repo={repo} />
    </>
  );
}
