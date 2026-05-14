"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard", label: "Agent Health" },
  { href: "/dashboard/tasks", label: "Tasks" },
  { href: "/dashboard/rooms", label: "War Rooms" },
  { href: "/dashboard/settings", label: "Settings" },
  { href: "/dashboard/settings/byok", label: "Credentials" },
] as const;

export function DashboardNav() {
  const pathname = usePathname();
  const activeHref =
    TABS
      .filter((tab) =>
        tab.href === "/dashboard"
          ? pathname === "/dashboard"
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`),
      )
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? "/dashboard";

  return (
    <div className="-mb-px flex gap-6">
      {TABS.map((tab) => {
        const isActive = tab.href === activeHref;

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
