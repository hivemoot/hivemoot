"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type Provider = "anthropic" | "openai";
type FormStatus = "idle" | "submitting" | "success" | "error";

interface Step2FormProps {
  installationId: string;
  sessionTtlSeconds: number;
}

interface SuccessData {
  provider: string;
  model: string;
  fingerprint: string;
  updatedAt: string;
}

const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
};

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const KEY_PLACEHOLDERS: Record<Provider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
};

// ---------------------------------------------------------------------------
// Inline SVG icons (no external libraries)
// ---------------------------------------------------------------------------

function AnthropicIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      {/* Simplified "A" mark */}
      <path d="M11.3 3H8.7L3 17h2.8l1.1-2.8h6.2L14.2 17H17L11.3 3Zm-2.8 9L10 6.6 11.5 12H8.5Z" />
    </svg>
  );
}

function OpenAIIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      {/* Simplified hexagon */}
      <path d="M10 2L17.32 6v8L10 18 2.68 14V6L10 2Zm0 2.16L4.68 7.08v5.84L10 15.84l5.32-2.92V7.08L10 4.16Z" />
    </svg>
  );
}

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
// Component
// ---------------------------------------------------------------------------

export default function Step2Form({
  installationId,
  sessionTtlSeconds,
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
          installationId,
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
              Your agents are ready to use {PROVIDER_LABELS[successData.provider as Provider] ?? successData.provider}.
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
              ···· {successData.fingerprint}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Saved</dt>
            <dd className="text-zinc-300">
              {new Date(successData.updatedAt).toLocaleString()}
            </dd>
          </div>
        </dl>
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
        <div>
          <h2 className="text-lg font-semibold text-[#fafafa]">
            Configure your API key
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-zinc-400">
            Provide an API key so your agents can call the LLM. The key is
            validated, encrypted, and never stored in plain text.
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

      {/* Provider selector — segmented button group */}
      <fieldset>
        <legend className="mb-2 text-sm text-zinc-400">Provider</legend>
        <div className="flex gap-2">
          {(["anthropic", "openai"] as const).map((p) => {
            const isActive = provider === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => switchProvider(p)}
                className={`
                  flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-2.5
                  text-sm font-medium transition-colors
                  ${
                    isActive
                      ? "border-honey-500/40 bg-honey-500/10 text-honey-400"
                      : "border-white/[0.06] bg-white/[0.03] text-zinc-400 hover:border-white/10 hover:text-zinc-300"
                  }
                `}
              >
                {p === "anthropic" ? (
                  <AnthropicIcon className="h-4 w-4" />
                ) : (
                  <OpenAIIcon className="h-4 w-4" />
                )}
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
          The model agents will use for reasoning.
        </p>
      </div>

      {/* API key field */}
      <div className="mt-5">
        <label htmlFor="api-key" className="mb-2 block text-sm text-zinc-400">
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
    </form>
  );
}
