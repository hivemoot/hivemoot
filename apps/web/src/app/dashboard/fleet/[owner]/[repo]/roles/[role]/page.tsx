import type { Metadata } from "next";
import { RoleEditor } from "./RoleEditor";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ owner: string; repo: string; role: string }>;
}): Promise<Metadata> {
  const { owner, repo, role } = await params;
  return {
    title: `${role} — ${owner}/${repo} — Hivemoot`,
    description: `Edit role instructions for ${role} in ${owner}/${repo}.`,
  };
}

export default async function RolePage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; role: string }>;
}) {
  const { owner, repo, role } = await params;

  return (
    <>
      <div className="mb-8">
        <p className="text-xs text-zinc-500 mb-1">
          {owner}/{repo}
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">{role}</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Edits open a PR in the repository for review before taking effect.
        </p>
      </div>

      <RoleEditor owner={owner} repo={repo} roleName={role} />
    </>
  );
}
