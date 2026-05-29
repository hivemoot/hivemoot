/**
 * Shared dashboard UI kit — the single source of truth for the dashboard's
 * visual language. Derived from the Tasks screens (the reference design).
 *
 * These are presentational components with no hooks, so they're usable from
 * both server and client components. Screens should render their chrome
 * (cards, headers, status, empty/loading/error states, buttons) from here
 * instead of hand-rolling class strings, so the whole dashboard stays
 * consistent.
 */

import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

// ---------------------------------------------------------------------------
// Status palette — one place that maps a semantic tone to Tailwind classes.
// ---------------------------------------------------------------------------

export type StatusTone = "green" | "blue" | "zinc" | "amber" | "red" | "honey";

interface ToneClasses {
  text: string;
  dot: string;
  bg: string;
}

const TONE: Record<StatusTone, ToneClasses> = {
  green: { text: "text-green-400", dot: "bg-green-400", bg: "bg-green-500/10" },
  blue: { text: "text-blue-400", dot: "bg-blue-400", bg: "bg-blue-500/10" },
  zinc: { text: "text-zinc-400", dot: "bg-zinc-400", bg: "bg-zinc-500/10" },
  amber: { text: "text-amber-400", dot: "bg-amber-400", bg: "bg-amber-500/10" },
  red: { text: "text-red-400", dot: "bg-red-400", bg: "bg-red-500/10" },
  honey: { text: "text-honey-400", dot: "bg-honey-400", bg: "bg-honey-500/10" },
};

export function toneClasses(tone: StatusTone): ToneClasses {
  return TONE[tone];
}

// ---------------------------------------------------------------------------
// Icons (kept here so the kit is self-contained)
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-4 w-4 animate-spin"} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Card — the canonical panel container.
// ---------------------------------------------------------------------------

export function Card({
  children,
  className = "",
  padding = "md",
}: {
  children: ReactNode;
  className?: string;
  /** md = p-4 sm:p-6 (default), lg = p-6 sm:p-8, none = no padding (e.g. lists). */
  padding?: "none" | "md" | "lg";
}) {
  const pad = padding === "lg" ? "p-6 sm:p-8" : padding === "md" ? "p-4 sm:p-6" : "";
  return (
    <div className={`rounded-2xl border border-white/[0.06] bg-[#141414] ${pad} ${className}`.trim()}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page + section headers
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions (buttons, links). */
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-zinc-400">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <h2 className="text-sm font-semibold text-[#fafafa]">{title}</h2>
      {description && <p className="mt-1 text-sm text-zinc-400">{description}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// State components: loading / empty / error
// ---------------------------------------------------------------------------

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-12 text-sm text-zinc-500">
      <Spinner />
      {label}
    </div>
  );
}

export function ErrorBanner({
  children,
  tone = "red",
  className = "",
}: {
  children: ReactNode;
  tone?: "red" | "amber";
  className?: string;
}) {
  const styles =
    tone === "amber"
      ? "border-amber-500/20 bg-amber-500/5 text-amber-400"
      : "border-red-500/20 bg-red-500/5 text-red-400";
  return (
    <div className={`rounded-lg border px-4 py-3 ${styles} ${className}`.trim()}>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center justify-center py-14 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-honey-500/10 text-honey-500">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-[#fafafa]">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-sm text-zinc-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge — pill with a colored dot + label.
// ---------------------------------------------------------------------------

export function StatusBadge({
  tone,
  label,
  pulse = false,
}: {
  tone: StatusTone;
  label: ReactNode;
  /** Animate the dot (e.g. for "running"). */
  pulse?: boolean;
}) {
  const t = TONE[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${t.bg}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot} ${pulse ? "animate-pulse" : ""}`} />
      <span className={`text-xs font-medium ${t.text}`}>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Button — primary / secondary / danger, optionally rendered as a Link.
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "danger";
type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-honey-500 font-semibold text-[#0a0a0a] hover:bg-honey-400 disabled:cursor-not-allowed disabled:opacity-50",
  secondary:
    "border border-white/[0.08] text-zinc-300 hover:border-white/20 hover:text-[#fafafa] disabled:cursor-not-allowed disabled:opacity-50",
  danger:
    "border border-white/[0.08] text-zinc-400 hover:border-red-500/30 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "gap-1.5 rounded-lg px-3 py-1.5 text-xs",
  md: "gap-2 rounded-lg px-4 py-2 text-sm",
};

function buttonClassName(variant: ButtonVariant, size: ButtonSize, extra = ""): string {
  return `inline-flex items-center justify-center font-medium transition-colors ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${extra}`.trim();
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
} & ComponentPropsWithoutRef<"button">) {
  return (
    <button className={buttonClassName(variant, size, className)} {...props}>
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className = "",
  href,
  children,
  external = false,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  const cls = buttonClassName(variant, size, className);
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}
