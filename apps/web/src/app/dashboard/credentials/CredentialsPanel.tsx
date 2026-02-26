"use client";

import { useCallback, useEffect, useState } from "react";
import { BYOK_ERROR } from "@/constants/byok-errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Provider = "anthropic" | "openai" | "google";

interface ByokStatus {
  status: "active" | "revoked";
  provider: string;
  model: string;
  updatedAt: string;
}

interface AgentTokenInfo {
  token: string;
  fingerprint: string;
  createdAt: string;
  createdBy: string;
}

type ByokState =
  | { kind: "loading" }
  | { kind: "not_configured" }
  | { kind: "configured"; data: ByokStatus }
  | { kind: "revoked"; data: ByokStatus }
  | { kind: "editing"; data: ByokStatus | null }
  | { kind: "error"; message: string };

type AgentTokenState =
  | { kind: "loading" }
  | { kind: "not_configured" }
  | { kind: "configured"; data: AgentTokenInfo }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

const PROVIDERS: Provider[] = ["anthropic", "openai", "google"];

// ---------------------------------------------------------------------------
// Inline SVG icons (project convention: no icon libraries)
// ---------------------------------------------------------------------------

function AnthropicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M9.218 2h2.402L16 12.987h-2.402zM4.379 2h2.512l4.38 10.987H8.82l-.895-2.308h-4.58l-.896 2.307H0L4.38 2.001zm2.755 6.64L5.635 4.777 4.137 8.64z" />
    </svg>
  );
}

function OpenAIIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z" />
    </svg>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
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
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 2l12 12" />
      <path d="M6.5 6.5a2 2 0 0 0 2.83 2.83" />
      <path d="M3.5 5.5C2.2 6.8 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.1 0 2.1-.3 3-.8" />
      <path d="M11 10.5c1.6-1.3 3.5-2.5 3.5-2.5s-2.5-4.5-6.5-4.5c-.5 0-1 .1-1.5.2" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-5 w-5"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <polyline points="5.5 8 7 9.5 10.5 6" />
    </svg>
  );
}

function XCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-5 w-5"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <line x1="6" y1="6" x2="10" y2="10" />
      <line x1="10" y1="6" x2="6" y2="10" />
    </svg>
  );
}

function KeyIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-5 w-5"} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="10" r="3" />
      <line x1="10" y1="10" x2="17" y2="10" />
      <line x1="14" y1="10" x2="14" y2="7" />
      <line x1="17" y1="10" x2="17" y2="7" />
    </svg>
  );
}

function TokenIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-5 w-5"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="12" height="6" rx="1" />
      <path d="M5 5V3.5a3 3 0 0 1 6 0V5" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? "h-4 w-4"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="5" width="8" height="8" rx="1" />
      <path d="M3 11V3a1 1 0 0 1 1-1h8" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Session expired banner
// ---------------------------------------------------------------------------

function SessionExpiredBanner() {
  return (
    <div role="alert" className="mb-6 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
      <XCircleIcon className="h-4 w-4 shrink-0 text-red-400" />
      <p className="text-sm text-red-400">
        Session expired.{" "}
        <a href="/setup" className="underline hover:text-red-300">
          Re-authenticate via Setup
        </a>{" "}
        to manage credentials.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSessionError(status: number, code?: string): boolean {
  return (
    status === 401 &&
    (code === BYOK_ERROR.NOT_AUTHENTICATED || code === BYOK_ERROR.SESSION_INVALID)
  );
}

async function parseErrorResponse(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { message: `Server returned an unexpected response (HTTP ${res.status})` };
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// LLM Credential Form
// ---------------------------------------------------------------------------

function LlmCredentialForm({
  initialProvider,
  initialModel,
  isRotate,
  onSaved,
  onCancel,
  onSessionExpired,
}: {
  initialProvider?: string;
  initialModel?: string;
  isRotate: boolean;
  onSaved: (data: ByokStatus) => void;
  onCancel?: () => void;
  onSessionExpired: () => void;
}) {
  const resolvedProvider = (initialProvider as Provider) ?? "anthropic";
  const [provider, setProvider] = useState<Provider>(resolvedProvider);
  const [model, setModel] = useState(initialModel ?? DEFAULT_MODELS[resolvedProvider]);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  function switchProvider(next: Provider) {
    if (next === provider) return;
    setProvider(next);
    setModel(DEFAULT_MODELS[next]);
    setApiKey("");
    setShowKey(false);
    setErrorMessage("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setErrorMessage("Please enter your API key.");
      return;
    }
    if (!model.trim()) {
      setErrorMessage("Please enter a model name.");
      return;
    }
    if (submitting) return;

    setSubmitting(true);
    setErrorMessage("");

    const endpoint = isRotate ? "/api/byok/rotate" : "/api/byok/config";

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model: model.trim(), apiKey: trimmedKey }),
      });

      if (res.ok) {
        const data = (await res.json()) as ByokStatus;
        onSaved(data);
        return;
      }

      const err = await parseErrorResponse(res);
      const errCode = err.code as string | undefined;
      const errMessage = err.message as string | undefined;

      if (isSessionError(res.status, errCode)) {
        onSessionExpired();
        return;
      }

      if (res.status === 400 && errCode === BYOK_ERROR.PROVIDER_INVALID) {
        setErrorMessage(
          errMessage ?? `${PROVIDER_LABELS[provider]} rejected the API key.`,
        );
        return;
      }

      if (res.status >= 500) {
        setErrorMessage("Something went wrong. Please try again later.");
        return;
      }

      setErrorMessage(errMessage ?? "Something went wrong. Please try again.");
    } catch {
      setErrorMessage("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {errorMessage && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
          <XCircleIcon className="h-4 w-4 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{errorMessage}</p>
        </div>
      )}

      {/* Provider selector */}
      <fieldset>
        <legend className="mb-2 text-sm text-zinc-400">Provider</legend>
        <div className="grid grid-cols-3 gap-2">
          {PROVIDERS.map((p) => {
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

      {/* Model */}
      <div className="mt-5">
        <label htmlFor="cred-model" className="mb-2 block text-sm text-zinc-400">
          Model
        </label>
        <input
          id="cred-model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 font-mono text-sm text-[#fafafa] placeholder-zinc-600 transition-colors focus:border-honey-500/50 focus:outline-none focus:ring-1 focus:ring-honey-500/20"
        />
      </div>

      {/* API key */}
      <div className="mt-5">
        <label htmlFor="cred-api-key" className="mb-2 block text-sm text-zinc-400">
          API key
        </label>
        <div className="relative">
          <input
            id="cred-api-key"
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

      {/* Actions */}
      <div className="mt-6 flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <>
              <SpinnerIcon />
              Validating…
            </>
          ) : isRotate ? (
            "Rotate key"
          ) : (
            "Save configuration"
          )}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-white/[0.06] px-5 py-2.5 text-sm text-zinc-400 transition-colors hover:border-white/10 hover:text-zinc-300"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// LLM Credentials Section
// ---------------------------------------------------------------------------

function LlmCredentialsSection({
  sessionExpired,
  onSessionExpired,
}: {
  sessionExpired: boolean;
  onSessionExpired: () => void;
}) {
  const [state, setState] = useState<ByokState>({ kind: "loading" });
  const [revoking, setRevoking] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/byok/status");

      if (res.ok) {
        const data = (await res.json()) as ByokStatus;
        setState({ kind: "configured", data });
        return;
      }

      const err = await parseErrorResponse(res);

      const errCode = err.code as string | undefined;
      const errMessage = err.message as string | undefined;

      if (isSessionError(res.status, errCode)) {
        onSessionExpired();
        setState({ kind: "error", message: "Session expired" });
        return;
      }

      if (res.status === 404) {
        setState({ kind: "not_configured" });
        return;
      }

      // 409 = revoked — the API includes metadata fields in the error body
      if (res.status === 409 && errCode === BYOK_ERROR.REVOKED) {
        setState({
          kind: "revoked",
          data: {
            status: "revoked",
            provider: String(err.provider ?? ""),
            model: String(err.model ?? ""),
            updatedAt: String(err.updatedAt ?? ""),
          },
        });
        return;
      }

      setState({ kind: "error", message: errMessage ?? "Failed to load credential status." });
    } catch {
      setState({ kind: "error", message: "Network error — could not reach server." });
    }
  }, [onSessionExpired]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  async function handleRevoke() {
    if (revoking) return;
    setRevoking(true);
    try {
      const res = await fetch("/api/byok/revoke", { method: "POST" });
      if (res.ok) {
        const body = await parseErrorResponse(res);
        setState({
          kind: "revoked",
          data: {
            status: "revoked",
            provider: String(body.provider ?? ""),
            model: String(body.model ?? ""),
            updatedAt: String(body.updatedAt ?? new Date().toISOString()),
          },
        });
        return;
      }
      const err = await parseErrorResponse(res);
      if (isSessionError(res.status, err.code as string | undefined)) {
        onSessionExpired();
        return;
      }
      setState({ kind: "error", message: String(err.message ?? "Failed to revoke credential.") });
    } catch {
      setState({ kind: "error", message: "Network error — could not reach server." });
    } finally {
      setRevoking(false);
    }
  }

  if (sessionExpired) {
    return null;
  }

  return (
    <section className="rounded-xl border border-white/[0.06] bg-[#141414] p-6 sm:p-8">
      <div className="mb-6 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-honey-500/10">
          <KeyIcon className="h-5 w-5 text-honey-500" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[#fafafa]">LLM API Key</h2>
          <p className="mt-0.5 text-sm text-zinc-400">
            Powers AI summaries, progress reports, and automation.
          </p>
        </div>
      </div>

      {state.kind === "loading" && (
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <SpinnerIcon />
          Loading credential status…
        </div>
      )}

      {state.kind === "error" && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
          <XCircleIcon className="h-4 w-4 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{state.message}</p>
        </div>
      )}

      {state.kind === "configured" && (
        <>
          <div className="mb-4 flex items-center gap-2">
            <CheckCircleIcon className="h-4 w-4 text-green-400" />
            <span className="text-sm font-medium text-green-400">Configured</span>
          </div>

          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Provider</dt>
              <dd className="text-zinc-300">
                {PROVIDER_LABELS[state.data.provider as Provider] ?? state.data.provider}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Model</dt>
              <dd className="font-mono text-zinc-300">{state.data.model}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Last updated</dt>
              <dd className="text-zinc-300">{formatDate(state.data.updatedAt)}</dd>
            </div>
          </dl>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => setState({ kind: "editing", data: state.data })}
              className="flex-1 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400"
            >
              Rotate key
            </button>
            <button
              type="button"
              onClick={handleRevoke}
              disabled={revoking}
              className="rounded-lg border border-red-500/20 px-5 py-2.5 text-sm text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {revoking ? "Revoking…" : "Revoke"}
            </button>
          </div>
        </>
      )}

      {state.kind === "revoked" && (
        <>
          <div className="mb-4 flex items-center gap-2">
            <XCircleIcon className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-500">Revoked</span>
          </div>
          <p className="mb-6 text-sm text-zinc-400">
            The previous {PROVIDER_LABELS[state.data.provider as Provider] ?? state.data.provider} key
            was revoked. Add a new key to re-enable AI features.
          </p>
          <LlmCredentialForm
            isRotate={false}
            onSaved={(data) => setState({ kind: "configured", data })}
            onSessionExpired={onSessionExpired}
          />
        </>
      )}

      {state.kind === "not_configured" && (
        <>
          <div className="mb-4 flex items-center gap-2">
            <XCircleIcon className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-500">Not configured</span>
          </div>
          <p className="mb-6 text-sm text-zinc-400">
            Add an API key to unlock AI-powered summaries, progress reports, and automation.
          </p>
          <LlmCredentialForm
            isRotate={false}
            onSaved={(data) => setState({ kind: "configured", data })}
            onSessionExpired={onSessionExpired}
          />
        </>
      )}

      {state.kind === "editing" && (
        <>
          <div className="my-4 h-px bg-white/[0.06]" />
          <LlmCredentialForm
            initialProvider={state.data?.provider}
            initialModel={state.data?.model}
            isRotate={true}
            onSaved={(data) => setState({ kind: "configured", data })}
            onCancel={() =>
              state.data
                ? setState({ kind: "configured", data: state.data })
                : setState({ kind: "not_configured" })
            }
            onSessionExpired={onSessionExpired}
          />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Agent Token Section
// ---------------------------------------------------------------------------

function AgentTokenSection({
  sessionExpired,
  onSessionExpired,
}: {
  sessionExpired: boolean;
  onSessionExpired: () => void;
}) {
  const [state, setState] = useState<AgentTokenState>({ kind: "loading" });
  const [showToken, setShowToken] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // Tracks whether the current token was just generated (raw token available
  // from the POST response). Existing tokens fetched via GET are also decrypted
  // and returned, but distinguishing "fresh" helps guide the user to copy it.
  const [justGenerated, setJustGenerated] = useState(false);

  const fetchToken = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-token");

      if (res.ok) {
        const data = (await res.json()) as AgentTokenInfo;
        setState({ kind: "configured", data });
        return;
      }

      const err = await parseErrorResponse(res);
      const errCode = err.code as string | undefined;
      const errMessage = err.message as string | undefined;

      if (isSessionError(res.status, errCode)) {
        onSessionExpired();
        setState({ kind: "error", message: "Session expired" });
        return;
      }

      if (res.status === 404) {
        setState({ kind: "not_configured" });
        return;
      }

      setState({ kind: "error", message: errMessage ?? "Failed to load agent token status." });
    } catch {
      setState({ kind: "error", message: "Network error — could not reach server." });
    }
  }, [onSessionExpired]);

  useEffect(() => {
    fetchToken();
  }, [fetchToken]);

  async function handleGenerate() {
    if (generating) return;
    setGenerating(true);
    setJustGenerated(false);
    try {
      const res = await fetch("/api/agent-token", { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { token: string; fingerprint: string; message: string };
        setState({
          kind: "configured",
          data: {
            token: data.token,
            fingerprint: data.fingerprint,
            createdAt: new Date().toISOString(),
            createdBy: "you",
          },
        });
        setJustGenerated(true);
        setShowToken(true);
        return;
      }
      const err = await parseErrorResponse(res);
      if (isSessionError(res.status, err.code as string | undefined)) {
        onSessionExpired();
        return;
      }
      setState({ kind: "error", message: String(err.message ?? "Failed to generate token.") });
    } catch {
      setState({ kind: "error", message: "Network error — could not reach server." });
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevoke() {
    if (revoking) return;
    setRevoking(true);
    try {
      const res = await fetch("/api/agent-token", { method: "DELETE" });
      if (res.ok) {
        setState({ kind: "not_configured" });
        setJustGenerated(false);
        setShowToken(false);
        return;
      }
      const err = await parseErrorResponse(res);
      if (isSessionError(res.status, err.code as string | undefined)) {
        onSessionExpired();
        return;
      }
      setState({ kind: "error", message: String(err.message ?? "Failed to revoke token.") });
    } catch {
      setState({ kind: "error", message: "Network error — could not reach server." });
    } finally {
      setRevoking(false);
    }
  }

  function handleCopy(token: string) {
    setCopyFailed(false);
    if (!navigator.clipboard?.writeText) {
      setCopyFailed(true);
      return;
    }
    navigator.clipboard.writeText(token).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        setCopyFailed(true);
      },
    );
  }

  if (sessionExpired) {
    return null;
  }

  return (
    <section className="rounded-xl border border-white/[0.06] bg-[#141414] p-6 sm:p-8">
      <div className="mb-6 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-honey-500/10">
          <TokenIcon className="h-5 w-5 text-honey-500" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[#fafafa]">Agent Token</h2>
          <p className="mt-0.5 text-sm text-zinc-400">
            Bearer token used by agents to authenticate health reports.
          </p>
        </div>
      </div>

      {state.kind === "loading" && (
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <SpinnerIcon />
          Loading token status…
        </div>
      )}

      {state.kind === "error" && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
          <XCircleIcon className="h-4 w-4 shrink-0 text-red-400" />
          <p className="text-sm text-red-400">{state.message}</p>
        </div>
      )}

      {state.kind === "configured" && (
        <>
          <div className="mb-4 flex items-center gap-2">
            <CheckCircleIcon className="h-4 w-4 text-green-400" />
            <span className="text-sm font-medium text-green-400">Active</span>
          </div>

          {justGenerated && (
            <div className="mb-4 rounded-lg border border-green-500/20 bg-green-500/5 px-4 py-3">
              <p className="text-sm text-green-400">
                Token generated. Copy it now — you can always retrieve it later from this page.
              </p>
            </div>
          )}

          {/* Token display */}
          <div className="mb-4">
            <label className="mb-2 block text-sm text-zinc-400">Token</label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showToken ? "text" : "password"}
                  readOnly
                  value={state.data.token}
                  className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 pr-10 font-mono text-sm text-[#fafafa] transition-colors focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-zinc-300"
                  aria-label={showToken ? "Hide token" : "Show token"}
                >
                  {showToken ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => handleCopy(state.data.token)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] text-zinc-400 transition-colors hover:border-white/10 hover:text-zinc-300"
                aria-label="Copy token"
              >
                {copied ? (
                  <CheckCircleIcon className="h-4 w-4 text-green-400" />
                ) : (
                  <CopyIcon />
                )}
              </button>
            </div>
            {copyFailed && (
              <p className="mt-1.5 text-xs text-red-400">
                Could not copy to clipboard. Please select the token manually and copy it.
              </p>
            )}
          </div>

          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Fingerprint</dt>
              <dd className="font-mono text-zinc-300">····{state.data.fingerprint}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Created</dt>
              <dd className="text-zinc-300">{formatDate(state.data.createdAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Created by</dt>
              <dd className="text-zinc-300">{state.data.createdBy}</dd>
            </div>
          </dl>

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="flex-1 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generating ? (
                <span className="flex items-center justify-center gap-2">
                  <SpinnerIcon />
                  Rotating…
                </span>
              ) : (
                "Rotate token"
              )}
            </button>
            <button
              type="button"
              onClick={handleRevoke}
              disabled={revoking}
              className="rounded-lg border border-red-500/20 px-5 py-2.5 text-sm text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {revoking ? "Revoking…" : "Revoke"}
            </button>
          </div>
        </>
      )}

      {state.kind === "not_configured" && (
        <>
          <div className="mb-4 flex items-center gap-2">
            <XCircleIcon className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-500">Not configured</span>
          </div>
          <p className="mb-6 text-sm text-zinc-400">
            Generate a bearer token so your agents can authenticate when sending health reports.
          </p>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? (
              <>
                <SpinnerIcon />
                Generating…
              </>
            ) : (
              "Generate token"
            )}
          </button>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function CredentialsPanel() {
  const [sessionExpired, setSessionExpired] = useState(false);

  return (
    <div className="space-y-6">
      {sessionExpired && <SessionExpiredBanner />}
      <LlmCredentialsSection
        sessionExpired={sessionExpired}
        onSessionExpired={() => setSessionExpired(true)}
      />
      <AgentTokenSection
        sessionExpired={sessionExpired}
        onSessionExpired={() => setSessionExpired(true)}
      />
    </div>
  );
}
