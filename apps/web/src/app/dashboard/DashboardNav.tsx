"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard", label: "Agent Health" },
  { href: "/dashboard/credentials", label: "Credentials" },
] as const;

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <div className="-mb-px flex gap-6">
      {TABS.map((tab) => {
        const isActive =
          tab.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(tab.href);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`border-b-2 pb-3 text-sm font-medium transition-colors ${
              isActive
                ? "border-honey-500 text-[#fafafa]"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
