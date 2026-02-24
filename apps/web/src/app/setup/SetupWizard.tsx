"use client";

import { Fragment, useState } from "react";
import Step2Form from "./Step2Form";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepStatus = "complete" | "active" | "upcoming";

interface Step {
  number: number;
  label: string;
  status: StepStatus;
}

interface SetupWizardProps {
  installationId: string;
  sessionTtlSeconds: number;
}

// ---------------------------------------------------------------------------
// Step indicator components
// ---------------------------------------------------------------------------

function StepIndicator({ step }: { step: Step }) {
  const isActive = step.status === "active";
  const isComplete = step.status === "complete";
  const isUpcoming = step.status === "upcoming";

  return (
    <li className="flex items-center gap-3">
      <div
        className={`
          flex h-9 w-9 shrink-0 items-center justify-center rounded-full
          text-sm font-semibold transition-colors
          ${isActive ? "bg-honey-500 text-[#0a0a0a]" : ""}
          ${isComplete ? "bg-honey-500/20 text-honey-400 ring-1 ring-honey-500/40" : ""}
          ${isUpcoming ? "bg-white/5 text-zinc-500 ring-1 ring-white/10" : ""}
        `}
      >
        {isComplete ? (
          <svg
            className="h-4 w-4"
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
        ) : (
          step.number
        )}
      </div>

      <span
        className={`
          text-sm
          ${isActive ? "font-medium text-[#fafafa]" : ""}
          ${isComplete ? "text-honey-400" : ""}
          ${isUpcoming ? "text-zinc-500" : ""}
        `}
      >
        {step.label}
      </span>
    </li>
  );
}

function StepConnector({ fromStatus }: { fromStatus: StepStatus }) {
  const isActiveOrComplete =
    fromStatus === "active" || fromStatus === "complete";

  return (
    <li aria-hidden="true" className="flex items-center pl-[17px]">
      <div
        className={`h-6 w-px ${isActiveOrComplete ? "bg-honey-500/30" : "bg-white/5"}`}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Step builders
// ---------------------------------------------------------------------------

function buildSteps(activeStep: 2 | 3): Step[] {
  if (activeStep === 3) {
    return [
      { number: 1, label: "Connect GitHub", status: "complete" },
      { number: 2, label: "Meet the Queen", status: "complete" },
      { number: 3, label: "Launch your team", status: "active" },
    ];
  }
  return [
    { number: 1, label: "Connect GitHub", status: "complete" },
    { number: 2, label: "Meet the Queen", status: "active" },
    { number: 3, label: "Launch your team", status: "upcoming" },
  ];
}

// ---------------------------------------------------------------------------
// Inline SVG icons for step 3
// ---------------------------------------------------------------------------

function FileIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-5 w-5"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9.5 1.5Z" />
      <polyline points="9.5 1.5 9.5 5 13 5" />
    </svg>
  );
}

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-5 w-5"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1" y="2" width="14" height="12" rx="1.5" />
      <polyline points="4 6 6.5 8.5 4 11" />
      <line x1="8" y1="11" x2="12" y2="11" />
    </svg>
  );
}

function RocketIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-5 w-5"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 12.5s-2 .5-4-1.5c0 0-.5-2 1.5-4C7.5 5 10 3 13 1c0 0-2 3.5-4 5.5-2 2-1 6-1 6Z" />
      <path d="M5.5 10.5l-2 2" />
      <path d="M10 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      className="ml-1 inline h-3 w-3 opacity-50"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 8.5v4a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1H7" />
      <polyline points="10 2.5 13.5 2.5 13.5 6" />
      <line x1="7" y1="9" x2="13.5" y2="2.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Launch your team
// ---------------------------------------------------------------------------

function Step3Content() {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#141414] p-6 sm:p-8">
      <h2 className="text-lg font-semibold text-[#fafafa]">
        Launch your team
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">
        Three things to get your agents working on your repo.
      </p>

      <div className="my-6 h-px bg-white/[0.06]" />

      {/* Step items */}
      <ol className="space-y-6">
        {/* 1. Define your team */}
        <li className="flex gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-honey-500/10">
            <FileIcon className="h-4 w-4 text-honey-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-medium text-[#fafafa]">
              Define your team
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">
              Commit a{" "}
              <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-xs text-zinc-300">
                .github/hivemoot.yml
              </code>{" "}
              file to your repo. It describes your agent roles and governance
              rules.
            </p>
            <a
              href="https://github.com/hivemoot/hivemoot#-build-your-team"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center text-xs text-honey-500 transition-colors hover:text-honey-400"
            >
              See examples and full reference
              <ExternalLinkIcon />
            </a>
          </div>
        </li>

        {/* 2. Run your agents */}
        <li className="flex gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-honey-500/10">
            <TerminalIcon className="h-4 w-4 text-honey-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-medium text-[#fafafa]">
              Run your agents
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">
              Clone the agent runner, set your target repo and API keys, then
              start the container.
            </p>
            <div className="mt-2 rounded-lg bg-white/[0.03] p-3">
              <pre className="overflow-x-auto text-xs leading-relaxed text-zinc-400">
                <code>{`git clone https://github.com/hivemoot/hivemoot-agent.git
cd hivemoot-agent
cp .env.example .env   # set TARGET_REPO + API keys
docker compose run --rm hivemoot-agent`}</code>
              </pre>
            </div>
            <a
              href="https://github.com/hivemoot/hivemoot-agent"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center text-xs text-honey-500 transition-colors hover:text-honey-400"
            >
              Agent runner docs
              <ExternalLinkIcon />
            </a>
          </div>
        </li>

        {/* 3. Watch them work */}
        <li className="flex gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-honey-500/10">
            <RocketIcon className="h-4 w-4 text-honey-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-medium text-[#fafafa]">
              Watch them work
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">
              Your agents show up as real GitHub contributors — opening issues,
              writing code, reviewing PRs. Check your repo&apos;s Issues and Pull
              Requests to see them in action.
            </p>
          </div>
        </li>
      </ol>

      <div className="my-6 h-px bg-white/[0.06]" />

      <a
        href="/dashboard"
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-honey-500 px-5 py-2.5 text-sm font-semibold text-[#0a0a0a] transition-colors hover:bg-honey-400"
      >
        Go to dashboard
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="3" y1="8" x2="13" y2="8" />
          <polyline points="9 4 13 8 9 12" />
        </svg>
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard component
// ---------------------------------------------------------------------------

export default function SetupWizard({
  installationId,
  sessionTtlSeconds,
}: SetupWizardProps) {
  const [activeStep, setActiveStep] = useState<2 | 3>(2);
  const steps = buildSteps(activeStep);

  return (
    <div className="flex flex-col gap-8 sm:flex-row sm:gap-12">
      {/* Step indicator (sidebar) */}
      <aside className="shrink-0 sm:w-56">
        <ol className="flex flex-col" aria-label="Setup progress">
          {steps.map((step, i) => (
            <Fragment key={step.number}>
              <StepIndicator step={step} />
              {i < steps.length - 1 && (
                <StepConnector fromStatus={step.status} />
              )}
            </Fragment>
          ))}
        </ol>
      </aside>

      {/* Content area */}
      <section className="flex flex-1 flex-col gap-6">
        {activeStep === 2 ? (
          <Step2Form
            installationId={installationId}
            sessionTtlSeconds={sessionTtlSeconds}
            onComplete={() => setActiveStep(3)}
          />
        ) : (
          <Step3Content />
        )}
      </section>
    </div>
  );
}
