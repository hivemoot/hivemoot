"use client";

import { useMemo, useState } from "react";

const AGENT_RUNNER_DOCS_URL = "https://github.com/hivemoot/hivemoot/tree/main/agent";
const GITHUB_APP_INSTALL_URL = "https://github.com/apps/hivemoot/installations/new";
const CREDENTIALS_URL = "/api/auth/github/start-discover?next=/dashboard/credentials";

type FlowStep = 1 | 2 | 3 | 4;
type ProviderId = "codex" | "claude" | "gemini" | "opencode";
type PluginId = "github" | "browser" | "cron";
type HivemootFeature = "health" | "tasks" | "githubWorkflows";

const FLOW_STEPS: { number: FlowStep; label: string }[] = [
  { number: 1, label: "Tool" },
  { number: 2, label: "Plugins" },
  { number: 3, label: "Hivemoot" },
  { number: 4, label: "Config" },
];

const PROVIDERS: Record<
  ProviderId,
  {
    label: string;
    eyebrow: string;
    detail: string;
    model: string;
    env: string[];
    secretLine: string;
  }
> = {
  codex: {
    label: "Codex",
    eyebrow: "OpenAI CLI",
    detail: "Good default for code tasks.",
    model: "gpt-5.5",
    env: [
      "AGENT_PROVIDER=codex",
      "AGENT_AUTH_MODE=api_key",
      "OPENAI_API_KEY_FILE=/run/secrets/openai_api_key",
      "AGENT_MODEL=gpt-5.5",
    ],
    secretLine: "openai_api_key: /run/secrets/openai_api_key",
  },
  claude: {
    label: "Claude Code",
    eyebrow: "Anthropic CLI",
    detail: "Use your Anthropic key.",
    model: "claude-opus-4-7",
    env: [
      "AGENT_PROVIDER=claude",
      "AGENT_AUTH_MODE=api_key",
      "ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key",
      "AGENT_MODEL=claude-opus-4-7",
    ],
    secretLine: "anthropic_api_key: /run/secrets/anthropic_api_key",
  },
  gemini: {
    label: "Gemini CLI",
    eyebrow: "Google CLI",
    detail: "Use your Google AI key.",
    model: "gemini-3.1-pro-preview",
    env: [
      "AGENT_PROVIDER=gemini",
      "AGENT_AUTH_MODE=api_key",
      "GEMINI_API_KEY_FILE=/run/secrets/gemini_api_key",
      "AGENT_MODEL=gemini-3.1-pro-preview",
    ],
    secretLine: "gemini_api_key: /run/secrets/gemini_api_key",
  },
  opencode: {
    label: "OpenCode",
    eyebrow: "OpenCode CLI",
    detail: "Use OpenRouter routing.",
    model: "anthropic/claude-opus-4.7",
    env: [
      "AGENT_PROVIDER=opencode",
      "AGENT_AUTH_MODE=api_key",
      "OPENCODE_PROVIDER=openrouter",
      "OPENCODE_MODEL=anthropic/claude-opus-4.7",
      "OPENROUTER_API_KEY_FILE=/run/secrets/openrouter_api_key",
    ],
    secretLine: "openrouter_api_key: /run/secrets/openrouter_api_key",
  },
};

const PLUGINS: {
  id: PluginId;
  label: string;
  detail: string;
  defaultEnabled: boolean;
}[] = [
  {
    id: "github",
    label: "GitHub",
    detail: "Pre-clone repos and wake agents from mentions, review requests, or new PRs.",
    defaultEnabled: true,
  },
  {
    id: "browser",
    label: "Browser",
    detail: "Attach a browser sidecar for page checks, web QA, and saved browser state.",
    defaultEnabled: false,
  },
  {
    id: "cron",
    label: "Cron",
    detail: "Run named prompts on a schedule for recurring maintenance work.",
    defaultEnabled: false,
  },
];

const HIVEMOOT_FEATURES: {
  id: HivemootFeature;
  label: string;
  detail: string;
  defaultEnabled: boolean;
}[] = [
  {
    id: "health",
    label: "Health reports",
    detail: "Show runner status in the dashboard.",
    defaultEnabled: true,
  },
  {
    id: "tasks",
    label: "Task system",
    detail: "Claim work and post results.",
    defaultEnabled: true,
  },
  {
    id: "githubWorkflows",
    label: "Hivemoot governance",
    detail: "Load proposal, voting, label, and PR coordination rules for Hivemoot repos.",
    defaultEnabled: false,
  },
];

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-5 w-5"}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836a9.59 9.59 0 012.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
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
      <rect x="5" y="5" width="8" height="8" rx="1" />
      <path d="M3 11V3a1 1 0 0 1 1-1h8" />
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

function AuthStatusBanner({ auth, reason }: { auth: string; reason?: string }) {
  if (auth === "ok") {
    return (
      <div className="rounded-lg border border-green-500/20 bg-green-500/5 px-4 py-3 text-sm text-green-400">
        GitHub authorization succeeded. Continue with Agent Token setup.
      </div>
    );
  }

  if (auth === "not_installed") {
    return null;
  }

  if (auth === "forbidden") {
    const message =
      reason === "not_org_admin"
        ? "You need to be an organization admin to configure this installation."
        : reason === "user_mismatch"
          ? "The GitHub account you authorized does not match this installation."
          : "You are not authorized to configure this installation.";

    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
        {message}
      </div>
    );
  }

  if (auth === "expired" || auth === "denied") {
    return (
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">
        GitHub authorization was not completed. You can still run agents locally.
      </div>
    );
  }

  return null;
}

function highlightCodeLine(line: string) {
  if (line.trimStart().startsWith("#")) {
    return <span className="text-zinc-600">{line}</span>;
  }

  const envMatch = line.match(/^([A-Z0-9_]+)(=)(.*)$/);
  if (envMatch) {
    return (
      <>
        <span className="text-honey-400">{envMatch[1]}</span>
        <span className="text-zinc-600">{envMatch[2]}</span>
        <span className="text-zinc-300">{envMatch[3]}</span>
      </>
    );
  }

  const shellMatch = line.match(/^([a-z][\w-]*)(\s.*)?$/);
  if (shellMatch && !line.includes(":")) {
    return (
      <>
        <span className="text-honey-400">{shellMatch[1]}</span>
        <span>{shellMatch[2] ?? ""}</span>
      </>
    );
  }

  const yamlMatch = line.match(/^(\s*)([\w.-]+)(:)(.*)$/);
  if (yamlMatch) {
    return (
      <>
        <span>{yamlMatch[1]}</span>
        <span className="text-honey-400">{yamlMatch[2]}</span>
        <span className="text-zinc-600">{yamlMatch[3]}</span>
        <span className={yamlMatch[4].includes("!secret") ? "text-green-400/80" : "text-zinc-300"}>
          {yamlMatch[4]}
        </span>
      </>
    );
  }

  if (line.trimStart().startsWith("- ")) {
    const indentation = line.match(/^\s*/)?.[0] ?? "";
    return (
      <>
        <span>{indentation}</span>
        <span className="text-zinc-600">- </span>
        <span className="text-zinc-300">{line.trimStart().slice(2)}</span>
      </>
    );
  }

  return <span>{line}</span>;
}

function CodeWidget({
  title,
  language,
  children,
}: {
  title: string;
  language: string;
  children: string;
}) {
  const [copied, setCopied] = useState(false);
  const lines = children.split("\n");

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d0d0f]">
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] bg-white/[0.025] px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-zinc-300">{title}</p>
          <p className="text-[10px] uppercase tracking-wide text-zinc-600">{language}</p>
        </div>
        <button
          type="button"
          onClick={copyCode}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.08] px-2.5 text-xs font-medium text-zinc-400 transition-colors hover:border-honey-500/30 hover:text-honey-400"
          aria-label={`Copy ${title}`}
        >
          <CopyIcon className="h-3.5 w-3.5" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-3 text-xs leading-6 text-zinc-400">
        <code>
          {lines.map((line, index) => (
            <span key={`${index}-${line}`} className="grid grid-cols-[2.25rem_1fr] gap-3">
              <span className="select-none text-right text-zinc-700">{index + 1}</span>
              <span>{highlightCodeLine(line)}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function StepNav({
  activeStep,
  onStepChange,
}: {
  activeStep: FlowStep;
  onStepChange: (step: FlowStep) => void;
}) {
  return (
    <aside className="shrink-0 lg:w-48">
      <ol className="flex gap-2 lg:flex-col lg:gap-0" aria-label="Setup progress">
        {FLOW_STEPS.map((step, index) => {
          const isActive = step.number === activeStep;
          const isComplete = step.number < activeStep;
          return (
            <li key={step.number} className="contents">
              <button
                type="button"
                onClick={() => onStepChange(step.number)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.03] lg:flex-none"
              >
                <span
                  className={`
                    flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors
                    ${isActive ? "bg-honey-500 text-[#0a0a0a]" : ""}
                    ${isComplete ? "bg-honey-500/20 text-honey-400 ring-1 ring-honey-500/40" : ""}
                    ${!isActive && !isComplete ? "bg-white/5 text-zinc-500 ring-1 ring-white/10" : ""}
                  `}
                >
                  {isComplete ? <CheckIcon /> : step.number}
                </span>
                <span
                  className={`truncate text-sm ${isActive ? "font-medium text-[#fafafa]" : isComplete ? "text-honey-400" : "text-zinc-500"}`}
                >
                  {step.label}
                </span>
              </button>
              {index < FLOW_STEPS.length - 1 && (
                <div aria-hidden="true" className="hidden pl-[22px] lg:block">
                  <div className={`h-5 w-px ${step.number < activeStep ? "bg-honey-500/30" : "bg-white/5"}`} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

function StepActions({
  activeStep,
  onStepChange,
}: {
  activeStep: FlowStep;
  onStepChange: (step: FlowStep) => void;
}) {
  const nextLabels: Record<Exclude<FlowStep, 4>, string> = {
    1: "Choose plugins",
    2: "Hivemoot options",
    3: "Generate config",
  };

  return (
    <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-5">
      <button
        type="button"
        onClick={() => onStepChange((activeStep - 1) as FlowStep)}
        disabled={activeStep === 1}
        className="rounded-lg border border-white/[0.08] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Back
      </button>
      {activeStep < 4 ? (
        <button
          type="button"
          onClick={() => onStepChange((activeStep + 1) as FlowStep)}
          className="rounded-lg bg-honey-500 px-4 py-2 text-sm font-semibold text-[#111114] transition-colors hover:bg-honey-400"
        >
          {nextLabels[activeStep as Exclude<FlowStep, 4>]}
        </button>
      ) : (
        <a
          href={AGENT_RUNNER_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-white/[0.08] px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/[0.03]"
        >
          Agent runner docs
        </a>
      )}
    </div>
  );
}

function OptionButton({
  active,
  eyebrow,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  eyebrow: string;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`
        group flex min-h-[104px] flex-col justify-between rounded-lg border p-4 text-left transition-colors
        ${active ? "border-honey-500/50 bg-honey-500/[0.08]" : "border-white/[0.07] bg-white/[0.015] hover:border-white/15 hover:bg-white/[0.03]"}
      `}
    >
      <span className="flex items-center justify-between gap-3">
        <span className={`text-[10px] font-medium uppercase tracking-wide ${active ? "text-honey-400" : "text-zinc-600"}`}>
          {eyebrow}
        </span>
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full border ${active ? "border-honey-500 bg-honey-500 text-[#111114]" : "border-white/10 text-transparent"}`}
        >
          <CheckIcon className="h-3 w-3" />
        </span>
      </span>
      <span>
        <span className="block text-base font-semibold text-[#fafafa]">{title}</span>
        <span className="mt-1 block text-sm text-zinc-500">{detail}</span>
      </span>
    </button>
  );
}

function ToggleRow({
  checked,
  label,
  detail,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  detail: string;
  onChange: () => void;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <div className="flex w-full items-center justify-between gap-4 border-b border-white/[0.06] py-4 text-left last:border-b-0 opacity-45">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-[#fafafa]">{label}</span>
          <span className="mt-1 block text-sm text-zinc-500">{detail}</span>
        </span>
        <span className="flex h-6 w-11 shrink-0 items-center rounded-full bg-white/10 p-0.5">
          <span className="h-5 w-5 rounded-full bg-[#111114]" />
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={onChange}
      className="flex w-full items-center justify-between gap-4 border-b border-white/[0.06] py-4 text-left last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-honey-500/25"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[#fafafa]">{label}</span>
        <span className="mt-1 block text-sm text-zinc-500">{detail}</span>
      </span>
      <span
        className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${checked ? "bg-honey-500" : "bg-white/10"}`}
      >
        <span
          className={`h-5 w-5 rounded-full bg-[#111114] transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`}
        />
      </span>
    </button>
  );
}

function StepHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: string;
}) {
  return (
    <header>
      <p className="text-xs font-medium uppercase tracking-wide text-honey-500">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#fafafa]">
        {title}
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
        {children}
      </p>
    </header>
  );
}

function ToolStep({
  provider,
  onProviderChange,
}: {
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
}) {
  return (
    <div>
      <StepHeader eyebrow="Start here" title="Which agent CLI should run?">
        Pick the runtime. You can change it later by editing AGENT_PROVIDER.
      </StepHeader>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
          const option = PROVIDERS[id];
          return (
            <OptionButton
              key={id}
              active={provider === id}
              eyebrow={option.eyebrow}
              title={option.label}
              detail={option.detail}
              onClick={() => onProviderChange(id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function PluginStep({
  selectedPlugins,
  onTogglePlugin,
}: {
  selectedPlugins: Record<PluginId, boolean>;
  onTogglePlugin: (plugin: PluginId) => void;
}) {
  return (
    <div>
      <StepHeader eyebrow="Plugin stack" title="What should the runner know how to do?">
        Choose the context, tools, and triggers to wire into this runner.
      </StepHeader>

      <div className="mt-5">
        {PLUGINS.map((plugin) => (
          <ToggleRow
            key={plugin.id}
            checked={selectedPlugins[plugin.id]}
            label={plugin.label}
            detail={plugin.detail}
            onChange={() => onTogglePlugin(plugin.id)}
          />
        ))}
      </div>
    </div>
  );
}

function HivemootStep({
  features,
  githubEnabled,
  onToggleFeature,
}: {
  features: Record<HivemootFeature, boolean>;
  githubEnabled: boolean;
  onToggleFeature: (feature: HivemootFeature) => void;
}) {
  return (
    <div>
      <StepHeader eyebrow="Dashboard connection" title="Should this runner report back?">
        Enable these when you want dashboard visibility or delegated tasks.
      </StepHeader>

      <div className="mt-5">
        {HIVEMOOT_FEATURES.map((feature) => (
          <ToggleRow
            key={feature.id}
            checked={features[feature.id]}
            label={feature.label}
            detail={
              feature.id === "githubWorkflows" && !githubEnabled
                ? "Requires the GitHub plugin."
                : feature.detail
            }
            disabled={feature.id === "githubWorkflows" && !githubEnabled}
            onChange={() => onToggleFeature(feature.id)}
          />
        ))}
      </div>

      {(features.health || features.tasks) && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a
            href={CREDENTIALS_URL}
            className="rounded-lg bg-honey-500 px-4 py-2 text-sm font-semibold text-[#111114] transition-colors hover:bg-honey-400"
          >
            Generate Agent Token
          </a>
          <span className="text-sm text-zinc-500">
            Needed for health reports and task execution.
          </span>
        </div>
      )}
    </div>
  );
}

function ConfigStep({
  generatedConfig,
  features,
  installationId,
}: {
  generatedConfig: string;
  features: Record<HivemootFeature, boolean>;
  installationId?: string;
}) {
  const appHref = installationId
    ? `/api/auth/github/start?installation_id=${encodeURIComponent(installationId)}`
    : GITHUB_APP_INSTALL_URL;

  return (
    <div>
      <StepHeader eyebrow="Generated config" title="Copy this into your local runner.">
        This is built from the choices you made.
      </StepHeader>

      <div className="mt-6">
        <CodeWidget title="Local runner config" language="env + yaml">
          {generatedConfig}
        </CodeWidget>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        {(features.health || features.tasks) && (
          <a
            href={CREDENTIALS_URL}
            className="rounded-lg bg-honey-500 px-4 py-2 text-sm font-semibold text-[#111114] transition-colors hover:bg-honey-400"
          >
            Generate Agent Token
          </a>
        )}
        {features.githubWorkflows && (
          <a
            href={appHref}
            className="inline-flex items-center gap-2 rounded-lg border border-honey-500/30 px-4 py-2 text-sm font-semibold text-honey-400 transition-colors hover:border-honey-500/50 hover:bg-honey-500/10"
          >
            <GitHubIcon className="h-4 w-4" />
            Optional GitHub App
          </a>
        )}
      </div>
    </div>
  );
}

function buildGeneratedConfig({
  provider,
  selectedPlugins,
  features,
}: {
  provider: ProviderId;
  selectedPlugins: Record<PluginId, boolean>;
  features: Record<HivemootFeature, boolean>;
}) {
  const envLines = [
    "# .env",
    ...PROVIDERS[provider].env,
    "AGENT_ID=worker",
    "WORKSPACE_ROOT=/workspace/repo",
  ];

  const pluginLines = ["# config/hivemoot.yaml", "plugins:"];

  if (selectedPlugins.github) {
    pluginLines.push(
      "  github:",
      "    repos:",
      "      - owner/repo",
      "    token_file: !secret github_token",
      "    workspace: /workspace/repo",
      "    # Optional event-driven runs:",
      "    # watch_mentions: true",
      "    # watch_review_requests: true",
      "    # watch_new_prs: true",
    );
  }

  if (selectedPlugins.browser) {
    pluginLines.push(
      "  browser:",
      "    cdp_url: http://hivemoot-browser:3000",
      "    state_dir: /state",
    );
  }

  if (selectedPlugins.cron) {
    pluginLines.push(
      "  cron:",
      "    schedules:",
      "      - name: autonomous",
      "        schedule: \"@every 1h\"",
      "        prompt: \"Inspect the repo and propose useful next work.\"",
    );
  }

  if (features.health || features.tasks || features.githubWorkflows) {
    pluginLines.push("  hivemoot:", "    token_file: !secret hivemoot_agent_token");

    if (features.health) {
      pluginLines.push(
        "    health:",
        "      enabled: true",
        "      repo: owner/repo",
      );
    }

    if (features.tasks) {
      pluginLines.push(
        "    tasks:",
        "      enabled: true",
        "      claim_url: https://www.hivemoot.dev/api/tasks/claim",
        "      execute_base_url: https://www.hivemoot.dev/api/tasks",
      );
    }

    if (features.githubWorkflows) {
      pluginLines.push(
        "    github_workflows:",
        "      enabled: true",
        "      role_name: builder",
      );
    }
  }

  if (pluginLines.length === 2) {
    pluginLines.push("  {}");
  }

  const secretLines = [
    "# config/hivemoot.secrets.yaml",
    PROVIDERS[provider].secretLine,
  ];

  if (selectedPlugins.github) {
    secretLines.push("github_token: /run/secrets/github_token");
  }

  if (features.health || features.tasks || features.githubWorkflows) {
    secretLines.push("hivemoot_agent_token: /run/secrets/hivemoot_agent_token");
  }

  return [
    "mkdir -p config secrets",
    "",
    ...envLines,
    "",
    ...pluginLines,
    "",
    ...secretLines,
  ].join("\n");
}

export default function SetupLocalFlow({
  auth,
  reason,
  installationId,
}: {
  auth?: string;
  reason?: string;
  installationId?: string;
}) {
  const [activeStep, setActiveStep] = useState<FlowStep>(1);
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [selectedPlugins, setSelectedPlugins] = useState<Record<PluginId, boolean>>(
    () =>
      PLUGINS.reduce(
        (acc, plugin) => ({ ...acc, [plugin.id]: plugin.defaultEnabled }),
        {} as Record<PluginId, boolean>,
      ),
  );
  const [features, setFeatures] = useState<Record<HivemootFeature, boolean>>(
    () =>
      HIVEMOOT_FEATURES.reduce(
        (acc, feature) => ({ ...acc, [feature.id]: feature.defaultEnabled }),
        {} as Record<HivemootFeature, boolean>,
      ),
  );

  const generatedConfig = useMemo(
    () => buildGeneratedConfig({ provider, selectedPlugins, features }),
    [features, provider, selectedPlugins],
  );

  function togglePlugin(plugin: PluginId) {
    setSelectedPlugins((current) => {
      const next = { ...current, [plugin]: !current[plugin] };
      if (plugin === "github" && !next.github) {
        setFeatures((currentFeatures) => ({
          ...currentFeatures,
          githubWorkflows: false,
        }));
      }
      return next;
    });
  }

  function toggleFeature(feature: HivemootFeature) {
    if (feature === "githubWorkflows" && !selectedPlugins.github) {
      return;
    }
    setFeatures((current) => ({ ...current, [feature]: !current[feature] }));
  }

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:gap-10">
      <StepNav activeStep={activeStep} onStepChange={setActiveStep} />

      <section className="min-w-0 flex-1 space-y-4">
        {auth && <AuthStatusBanner auth={auth} reason={reason} />}

        <div id="local-agent-setup" className="rounded-xl border border-white/[0.06] bg-[#141414] p-6 sm:p-8">
          {activeStep === 1 && (
            <ToolStep provider={provider} onProviderChange={setProvider} />
          )}
          {activeStep === 2 && (
            <PluginStep
              selectedPlugins={selectedPlugins}
              onTogglePlugin={togglePlugin}
            />
          )}
          {activeStep === 3 && (
            <HivemootStep
              features={features}
              githubEnabled={selectedPlugins.github}
              onToggleFeature={toggleFeature}
            />
          )}
          {activeStep === 4 && (
            <ConfigStep
              generatedConfig={generatedConfig}
              features={features}
              installationId={installationId}
            />
          )}

          <StepActions activeStep={activeStep} onStepChange={setActiveStep} />
        </div>
      </section>
    </div>
  );
}
