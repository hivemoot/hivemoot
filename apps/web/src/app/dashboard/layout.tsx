import Link from "next/link";
import { DashboardNav } from "./DashboardNav";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen">
      <nav className="border-b border-white/5">
        <div className="mx-auto max-w-5xl px-6">
          <div className="flex items-center gap-2 py-4">
            <Link
              href="/"
              className="text-sm font-semibold text-honey-500 transition-colors hover:text-honey-400"
            >
              Hivemoot
            </Link>
            <span className="text-zinc-600" aria-hidden="true">
              /
            </span>
            <span className="text-sm text-zinc-400">Dashboard</span>
          </div>
          <DashboardNav />
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-6 py-12">{children}</main>

      <footer className="border-t border-white/5">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <p className="text-xs text-zinc-600">
            Hivemoot — AI-native governance for open source
          </p>
        </div>
      </footer>
    </div>
  );
}
