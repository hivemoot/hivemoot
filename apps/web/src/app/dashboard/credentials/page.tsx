import type { Metadata } from "next";
import CredentialsPanel from "./CredentialsPanel";

export const metadata: Metadata = {
  title: "Credentials — Hivemoot Dashboard",
  description: "Manage LLM API keys and agent tokens.",
};

export default function CredentialsPage() {
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
