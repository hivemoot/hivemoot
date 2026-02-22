"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type Provider = "anthropic" | "openai" | "google";
type FormStatus = "idle" | "submitting" | "success" | "error" | "skipped";

interface Step2FormProps {
  installationId: string;
  sessionTtlSeconds: number;
  onComplete?: () => void;
}

interface SuccessData {
  provider: string;
  model: string;
  fingerprint: string;
  updatedAt: string;
}

const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.2",
  google: "gemini-3-flash-preview",
};

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

const KEY_PLACEHOLDERS: Record<Provider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  google: "AIza...",
};

// ---------------------------------------------------------------------------
// Inline SVG icons (no external libraries)
// Official brand marks: Anthropic, OpenAI from Bootstrap Icons; Google "G"
// from Google Fonts assets; Mistral pixel-grid from brand guidelines.
// ---------------------------------------------------------------------------

function AnthropicIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path fillRule="evenodd" d="M9.218 2h2.402L16 12.987h-2.402zM4.379 2h2.512l4.38 10.987H8.82l-.895-2.308h-4.58l-.896 2.307H0L4.38 2.001zm2.755 6.64L5.635 4.777 4.137 8.64z" />
    </svg>
  );
}

function OpenAIIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z" />
    </svg>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

const PROVIDER_ICONS: Record<Provider, typeof AnthropicIcon> = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  google: GoogleIcon,
};

function EyeIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 2l12 12" />
      <path d="M6.5 6.5a2 2 0 0 0 2.83 2.83" />
      <path d="M3.5 5.5C2.2 6.8 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.1 0 2.1-.3 3-.8" />
      <path d="M11 10.5c1.6-1.3 3.5-2.5 3.5-2.5s-2.5-4.5-6.5-4.5c-.5 0-1 .1-1.5.2" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-4 w-4"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Educational section icons
// ---------------------------------------------------------------------------

function GearIcon({ className }: { className?: string }) {
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
      <circle cx="8" cy="8" r="2.5" />
      <path d="M6.8 2.4l-.5 1.2a4.5 4.5 0 0 0-1.2.7L3.9 4 2.8 5.8l.8 1a4.5 4.5 0 0 0 0 1.4l-.8 1L3.9 11l1.2-.3a4.5 4.5 0 0 0 1.2.7l.5 1.2h2.4l.5-1.2a4.5 4.5 0 0 0 1.2-.7l1.2.3 1.1-1.8-.8-1a4.5 4.5 0 0 0 0-1.4l.8-1L12.1 4l-1.2.3a4.5 4.5 0 0 0-1.2-.7L9.2 2.4H6.8Z" />
    </svg>
  );
}

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-4 w-4"}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5L8 1Z" />
    </svg>
  );
}

function SlidersIcon({ className }: { className?: string }) {
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
      <line x1="2" y1="4" x2="14" y2="4" />
      <circle cx="5" cy="4" r="1.5" fill="currentColor" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <circle cx="10" cy="8" r="1.5" fill="currentColor" />
      <line x1="2" y1="12" x2="14" y2="12" />
      <circle cx="7" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Queen intro — educate before asking for a key
// ---------------------------------------------------------------------------

interface CardSlide {
  title: string;
  badge: string;
  badgeClass: string;
  iconSlot: React.ReactNode;
  items: { icon: React.ReactNode; text: string }[];
  footer?: React.ReactNode;
}

const SLIDES: CardSlide[] = [
  {
    title: "Team Coordination",
    badge: "Included",
    badgeClass: "bg-green-500/10 text-green-400",
    iconSlot: <GearIcon className="h-4 w-4 text-green-400" />,
    items: [
      { icon: <CheckIcon className="h-3.5 w-3.5 text-green-400" />, text: "Organizes work from idea to shipped code" },
      { icon: <CheckIcon className="h-3.5 w-3.5 text-green-400" />, text: "Your team drives decisions collaboratively" },
      { icon: <CheckIcon className="h-3.5 w-3.5 text-green-400" />, text: "Multiple solutions compete — the best wins" },
      { icon: <CheckIcon className="h-3.5 w-3.5 text-green-400" />, text: "Stale work gets cleaned up automatically" },
    ],
  },
  {
    title: "AI-Powered Insights",
    badge: "Optional",
    badgeClass: "bg-zinc-500/10 text-zinc-500",
    iconSlot: <SparkleIcon className="h-4 w-4 text-honey-500" />,
    items: [
      { icon: <SparkleIcon className="h-3.5 w-3.5 text-honey-500" />, text: "Summarizes issues and PRs for you" },
      { icon: <SparkleIcon className="h-3.5 w-3.5 text-honey-500" />, text: "Writes daily progress reports" },
      { icon: <SparkleIcon className="h-3.5 w-3.5 text-honey-500" />, text: "Generates commit messages automatically" },
      { icon: <SparkleIcon className="h-3.5 w-3.5 text-honey-500" />, text: "Creates implementation plans from issues" },
    ],
    footer: (
      <p className="text-xs text-zinc-500">
        Requires an API key. Usage is low — we recommend setting a spending
        limit.
      </p>
    ),
  },
  {
    title: "Fully Customizable",
    badge: "",
    badgeClass: "hidden",
    iconSlot: <SlidersIcon className="h-4 w-4 text-zinc-400" />,
    items: [
      { icon: <GearIcon className="h-3.5 w-3.5 text-zinc-500" />, text: "Define how issues flow into proposals" },
      { icon: <GearIcon className="h-3.5 w-3.5 text-zinc-500" />, text: "Manage discussion and feedback rounds" },
      { icon: <GearIcon className="h-3.5 w-3.5 text-zinc-500" />, text: "Auto-merge when enough approvals come in" },
      { icon: <GearIcon className="h-3.5 w-3.5 text-zinc-500" />, text: "Tune the entire workflow to fit your team" },
    ],
    footer: (
      <p className="text-xs text-zinc-500">
        One config file:{" "}
        <code className="rounded bg-white/[0.06] px-1 py-0.5 text-zinc-400">
          .github/hivemoot.yml
        </code>
      </p>
    ),
  },
];

function ChevronLeftIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="10 3 5 8 10 13" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 3 11 8 6 13" />
    </svg>
  );
}

function QueenIntro() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const timerIdRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = useCallback(() => {
    if (timerIdRef.current) {
      clearInterval(timerIdRef.current);
      timerIdRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    timerIdRef.current = setInterval(() => {
      setActive((i) => (i + 1) % SLIDES.length);
    }, 8000);
  }, [stopTimer]);

  useEffect(() => {
    if (!paused) startTimer();
    return stopTimer;
  }, [paused, startTimer, stopTimer]);

  function goTo(index: number) {
    setActive(index);
    if (!paused) startTimer();
  }

  function prev() {
    setActive((i) => (i - 1 + SLIDES.length) % SLIDES.length);
    if (!paused) startTimer();
  }

  function next() {
    setActive((i) => (i + 1) % SLIDES.length);
    if (!paused) startTimer();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium text-[#fafafa]">
          Meet the Queen
        </h3>
        <p className="mt-1 text-sm text-zinc-500">
          She manages your repos — organizing work, gathering feedback, and
          shipping code.
        </p>
      </div>

      {/* Carousel — pauses on hover, arrows to navigate */}
      <div
        className="overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div
          className="flex transition-transform duration-500 ease-in-out"
          style={{ transform: `translateX(-${active * 100}%)` }}
        >
          {SLIDES.map((slide, i) => (
            <div
              key={i}
              className="w-full shrink-0 p-4"
              aria-hidden={i !== active}
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {slide.iconSlot}
                  <span className="text-sm font-medium text-[#fafafa]">
                    {slide.title}
                  </span>
                </div>
                {slide.badge && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${slide.badgeClass}`}
                  >
                    {slide.badge}
                  </span>
                )}
              </div>
              <ul className="ml-6 space-y-1.5">
                {slide.items.map((item, j) => (
                  <li
                    key={j}
                    className="flex items-start gap-2 text-sm text-zinc-400"
                  >
                    <span className="mt-0.5 shrink-0">{item.icon}</span>
                    {item.text}
                  </li>
                ))}
              </ul>
              {slide.footer && <div className="mt-3">{slide.footer}</div>}
            </div>
          ))}
        </div>

        {/* Navigation: arrows + dots */}
        <div className="flex items-center justify-between px-4 pb-3">
          <button
            type="button"
            onClick={prev}
            className="flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
            aria-label="Previous"
          >
            <ChevronLeftIcon />
          </button>

          <div className="flex gap-1.5">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === active
                    ? "w-4 bg-honey-500"
                    : "w-1.5 bg-white/10 hover:bg-white/20"
                }`}
                aria-label={`Show feature ${i + 1}`}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={next}
            className="flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
            aria-label="Next"
          >
            <ChevronRightIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Step2Form({
  installationId,
  sessionTtlSeconds,
  onComplete,
}: Step2FormProps) {
  // Compute expiry once at mount time. Subtract a 5-second buffer to account
  // for time consumed by the redirect + page load after the session was created.
  const [sessionExpiresAt] = useState(
    () => Date.now() + (sessionTtlSeconds - 5) * 1000,
  );
  // Form state
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [model, setModel] = useState(DEFAULT_MODELS.anthropic);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  // Submission state
  const [status, setStatus] = useState<FormStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [successData, setSuccessData] = useState<SuccessData | null>(null);

  // Session countdown
  const [sessionExpired, setSessionExpired] = useState(false);
  const [minutesRemaining, setMinutesRemaining] = useState<number | null>(null);

  // -----------------------------------------------------------------------
  // Session countdown timer
  // -----------------------------------------------------------------------
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function update() {
      const remaining = sessionExpiresAt - Date.now();
      if (remaining <= 0) {
        setSessionExpired(true);
        setMinutesRemaining(0);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return;
      }
      const mins = Math.ceil(remaining / 60_000);
      setMinutesRemaining(mins);
    }

    update();
    // Only start polling if not already expired after the initial check
    if (!timerRef.current) {
      timerRef.current = setInterval(update, 15_000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [sessionExpiresAt]);

  // -----------------------------------------------------------------------
  // Provider switch
  // -----------------------------------------------------------------------
  const switchProvider = useCallback(
    (next: Provider) => {
      if (next === provider) return;
      setProvider(next);
      setModel(DEFAULT_MODELS[next]);
      setApiKey("");
      setShowKey(false);
      setStatus("idle");
      setErrorMessage("");
      setErrorCode("");
    },
    [provider],
  );

  // -----------------------------------------------------------------------
  // Submit
  // -----------------------------------------------------------------------
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmedKey = apiKey.trim();

    // Client-side validation
    if (!trimmedKey) {
      setStatus("error");
      setErrorMessage("Please enter your API key.");
      setErrorCode("");
      return;
    }
    if (!model.trim()) {
      setStatus("error");
      setErrorMessage("Please enter a model name.");
      setErrorCode("");
      return;
    }

    // Guards
    if (status === "submitting") return;
    if (sessionExpired) return;

    setStatus("submitting");
    setErrorMessage("");
    setErrorCode("");

    try {
      const res = await fetch("/api/byok/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          apiKey: trimmedKey,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as SuccessData;
        setSuccessData(data);
        setStatus("success");
        return;
      }

      // Error handling
      const err = (await res.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };

      if (
        res.status === 401 &&
        (err.code === "byok_not_authenticated" ||
          err.code === "byok_session_invalid")
      ) {
        setSessionExpired(true);
        setMinutesRemaining(0);
        setStatus("error");
        setErrorCode(err.code);
        setErrorMessage("Your session has expired.");
        return;
      }

      if (res.status === 400 && err.code === "byok_provider_invalid") {
        setStatus("error");
        setErrorCode(err.code);
        setErrorMessage(
          err.message ?? `${PROVIDER_LABELS[provider]} rejected the API key.`,
        );
        return;
      }

      // Generic server error
      setStatus("error");
      setErrorCode(err.code ?? "");
      setErrorMessage(err.message ?? "Something went wrong. Please try again.");
    } catch {
      setStatus("error");
      setErrorCode("");
      setErrorMessage(
        "Could not reach the server. Check your connection and try again.",
      );
    }
  }

  // -----------------------------------------------------------------------
  // Session expiry banner
  // -----------------------------------------------------------------------
  const restartHref = `/api/auth/github/start?installation_id=${encodeURIComponent(installationId)}`;

  const sessionBanner =
    sessionExpired ? (
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
        <svg
          className="h-4 w-4 shrink-0 text-red-400"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" />
          <line x1="8" y1="5" x2="8" y2="8.5" />
          <circle cx="8" cy="11" r="0.5" fill="currentColor" />
        </svg>
        <p className="text-sm text-red-400">
          Session expired.{" "}
          <a href={restartHref} className="underline hover:text-red-300">
            Restart setup
          </a>{" "}
          to continue.
        </p>
      </div>
    ) : minutesRemaining !== null && minutesRemaining <= 1 ? (
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
        <p className="text-sm text-amber-400">
          Session expires in less than a minute.
        </p>
      </div>
    ) : minutesRemaining !== null && minutesRemaining <= 5 ? (
      <p className="mb-4 text-xs text-zinc-500">
        Session expires in {minutesRemaining} minute
        {minutesRemaining !== 1 ? "s" : ""}
      </p>
    ) : null;

  // -----------------------------------------------------------------------
  // Success view
  // -----------------------------------------------------------------------
  if (status === "success" && successData) {
    return (
      <div className="rounded-xl border border-green-500/20 bg-[#141414] p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/10">
            <CheckIcon className="h-5 w-5 text-green-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[#fafafa]">
              API key configured
            </h2>
            <p className="mt-0.5 text-sm text-zinc-400">
              The Queen is ready — powered by {PROVIDER_LABELS[successData.provider as Provider] ?? successData.provider}.
            </p>
          </div>
        </div>

        <div className="my-6 h-px bg-white/[0.06]" />

        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-zinc-500">Provider</dt>
            <dd className="text-zinc-300">
              {PROVIDER_LABELS[successData.provider as Provider] ?? successData.provider}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Model</dt>
            <dd className="font-mono text-zinc-300">{successData.model}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Key</dt>
            <dd className="font-mono text-zinc-300">
              ····
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Saved</dt>
            <dd className="text-zinc-300">
              {new Date(successData.updatedAt).toLocaleString()}
            </dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={() => onComplete?.()}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400"
        >
          Continue
          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="3" y1="8" x2="13" y2="8" />
            <polyline points="9 4 13 8 9 12" />
          </svg>
        </button>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Skipped view
  // -----------------------------------------------------------------------
  if (status === "skipped") {
    return (
      <div className="rounded-xl border border-honey-500/20 bg-[#141414] p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-honey-500/10">
            <CheckIcon className="h-5 w-5 text-honey-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[#fafafa]">
              Governance automation is running
            </h2>
            <p className="mt-0.5 text-sm text-zinc-400">
              You can add an AI key anytime from your dashboard.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onComplete?.()}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400"
        >
          Continue
          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="3" y1="8" x2="13" y2="8" />
            <polyline points="9 4 13 8 9 12" />
          </svg>
        </button>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Form view
  // -----------------------------------------------------------------------
  const isSessionError =
    errorCode === "byok_not_authenticated" ||
    errorCode === "byok_session_invalid";

  return (
    <div className="flex flex-col gap-5">
      {/* Compact Step 1 success */}
      <div className="flex items-center gap-2.5 px-1 py-1">
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-500/15">
          <svg
            className="h-3 w-3 text-green-400"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
          </svg>
        </div>
        <span className="text-sm text-zinc-400">
          Connected — the Queen is watching your repos
          <span className="text-zinc-600"> (Hivemoot GitHub App installed)</span>
        </span>
      </div>

      <QueenIntro />

      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-white/[0.06] bg-[#141414] p-6 sm:p-8"
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-honey-500/10">
            <svg
              className="h-5 w-5 text-honey-500"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {/* Key icon */}
              <circle cx="7" cy="10" r="3" />
              <line x1="10" y1="10" x2="17" y2="10" />
              <line x1="14" y1="10" x2="14" y2="7" />
              <line x1="17" y1="10" x2="17" y2="7" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-[#fafafa]">
                Unlock AI features
              </h2>
              <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-xs font-medium text-zinc-500">
                Optional
              </span>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">
              Add an API key to unlock AI-powered summaries, progress reports,
              and automation. Usage is low — we recommend setting a spending
              limit on your key.
            </p>
          </div>
        </div>

        <div className="my-6 h-px bg-white/[0.06]" />

        {/* Session warning / expiry */}
        {sessionBanner}

        {/* Error banner */}
        {status === "error" && errorMessage && !isSessionError && (
          <div className="mb-6 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
            <svg
              className="h-4 w-4 shrink-0 text-red-400"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
            <p className="text-sm text-red-400">{errorMessage}</p>
          </div>
        )}

        {/* Provider selector — 2×2 grid */}
        <fieldset>
          <legend className="mb-2 text-sm text-zinc-400">Provider</legend>
          <div className="grid grid-cols-3 gap-2">
            {(["anthropic", "openai", "google"] as const).map((p) => {
              const isActive = provider === p;
              const Icon = PROVIDER_ICONS[p];
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => switchProvider(p)}
                  className={`
                    flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5
                    text-sm font-medium transition-colors
                    ${
                      isActive
                        ? "border-honey-500/40 bg-honey-500/10 text-honey-400"
                        : "border-white/[0.06] bg-white/[0.03] text-zinc-400 hover:border-white/10 hover:text-zinc-300"
                    }
                  `}
                >
                  <Icon className="h-4 w-4" />
                  {PROVIDER_LABELS[p]}
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Model field */}
        <div className="mt-5">
          <label htmlFor="model" className="mb-2 block text-sm text-zinc-400">
            Model
          </label>
          <input
            id="model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 font-mono text-sm text-[#fafafa] placeholder-zinc-600 transition-colors focus:border-honey-500/50 focus:outline-none focus:ring-1 focus:ring-honey-500/20"
          />
          <p className="mt-1.5 text-xs text-zinc-500">
            The model the Queen uses for AI features.
          </p>
        </div>

        {/* API key field */}
        <div className="mt-5">
          <label
            htmlFor="api-key"
            className="mb-2 block text-sm text-zinc-400"
          >
            API key
          </label>
          <div className="relative">
            <input
              id="api-key"
              type={showKey ? "text" : "password"}
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={KEY_PLACEHOLDERS[provider]}
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 pr-10 font-mono text-sm text-[#fafafa] placeholder-zinc-600 transition-colors focus:border-honey-500/50 focus:outline-none focus:ring-1 focus:ring-honey-500/20"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-zinc-300"
              aria-label={showKey ? "Hide API key" : "Show API key"}
            >
              {showKey ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-zinc-500">
            Your key is validated, encrypted, and never stored in plain text.
          </p>
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={status === "submitting" || sessionExpired}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "submitting" ? (
            <>
              <SpinnerIcon />
              Validating your API key…
            </>
          ) : (
            "Save configuration"
          )}
        </button>

        {/* Skip */}
        <button
          type="button"
          onClick={() => setStatus("skipped")}
          className="mt-3 flex w-full items-center justify-center rounded-lg px-5 py-2.5 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
        >
          Skip for now — you can add this later
        </button>
      </form>
    </div>
  );
}
