# Global build arg — controls which provider stage becomes the runtime image.
# Must be at global scope (before first FROM) to be usable in FROM directives.
# Values: all | codex | gemini | kilo | opencode | claude
ARG PROVIDER=all
ARG GH_VERSION=2.92.0

FROM golang:1.27.1-bookworm AS gh-builder

ARG GH_VERSION
RUN GOBIN=/tmp/gh-bin go install github.com/cli/cli/v2/cmd/gh@v${GH_VERSION}

FROM node:24-slim AS base

ARG DEBIAN_FRONTEND=noninteractive
ARG NPM_VERSION=11.11.1
ARG HIVEMOOT_CLI_VERSION=latest

# Install system dependencies. Build gh from source with a patched Go toolchain
# until the upstream apt package stops shipping a vulnerable Go stdlib.
# The explicit --only-upgrade pass keeps cached base-image packages current
# when CI's Docker layer cache predates Debian security fixes; Trivy scans the
# final image, not the cache age.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  git \
  jq \
  less \
  openssh-client \
  procps \
  python3 \
  python3-pip \
  ripgrep \
  tini \
  && apt-get install -y --no-install-recommends --only-upgrade \
  libc-bin \
  libc6 \
  libcap2 \
  libgnutls30 \
  libpython3.11-minimal \
  libpython3.11-stdlib \
  libsystemd0 \
  libudev1 \
  openssh-client \
  python3.11 \
  python3.11-minimal \
  && rm -rf /var/lib/apt/lists/*
COPY --from=gh-builder /tmp/gh-bin/gh /usr/local/bin/gh

# Keep the base npm installation patched before switching to a custom global
# prefix; this removes vulnerable tar transitive dependencies from npm itself.
RUN env -u NPM_CONFIG_PREFIX npm install -g "npm@${NPM_VERSION}" \
  && env -u NPM_CONFIG_PREFIX npm cache clean --force

RUN mkdir -p /usr/local/share/npm-global \
  && chown -R node:node /usr/local/share/npm-global

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV HOME=/home/node
ENV PATH=/home/node/.local/bin:/usr/local/share/npm-global/bin:${PATH}

USER node

# Python config layer — Pydantic for typed plugin config + PyYAML for
# parsing the unified hivemoot.yaml / hivemoot.secrets.yaml format.
# Pinned to Pydantic v2 (the Debian-packaged v1 is too old; see
# docs/adr/003-plugin-config.md for the design rationale).  Installs
# into /home/node/.local/ which is already on PATH (line 46).
#
# Both flags are required on Debian 12: ``--user`` writes into
# /home/node/.local/ (the only path the runtime user can write), but
# PEP 668 still rejects it because the system Python is marked
# externally-managed.  ``--break-system-packages`` opts out of the
# check.  We're not touching the system site-packages; this is a
# single-purpose container and the install lands in the user prefix
# regardless.
ARG PYDANTIC_VERSION="2.11.*"
ARG PYYAML_VERSION="6.0.*"
RUN pip3 install --user --break-system-packages --no-cache-dir \
  "pydantic==${PYDANTIC_VERSION}" \
  "PyYAML==${PYYAML_VERSION}"

# Install hivemoot CLI in the base stage — needed in every provider variant.
RUN npm install -g "@hivemoot-dev/cli@${HIVEMOOT_CLI_VERSION}" \
  && npm cache clean --force

# agent-browser (Vercel Labs) — LLM-agent-optimized browser CLI.  Plugins
# like apiary-browser shell out to it for navigate/click/type/snapshot/
# screenshot against a remote Chrome via --cdp.  We deliberately skip
# `agent-browser install` (Chrome download) because all browser sessions
# run in the hivemoot-browser sidecar and we attach via CDP — the CLI
# acts as a client, not a browser launcher.  Keeps the image lean.
ARG AGENT_BROWSER_VERSION=0.26.0
RUN npm install -g "agent-browser@${AGENT_BROWSER_VERSION}" \
  && npm cache clean --force

USER root

RUN ln -sf /usr/local/share/npm-global/bin/hivemoot /usr/local/bin/hivemoot \
  && ln -sf /usr/local/share/npm-global/bin/agent-browser /usr/local/bin/agent-browser

USER node

# -----------------------------------------------------------------------------
# Provider stages — each installs exactly one provider CLI.
# The `all` stage installs every provider (backward-compatible default).
# Select a stage via DOCKER_PROVIDER in .env (passed as --build-arg PROVIDER).
# -----------------------------------------------------------------------------

FROM base AS provider-codex
ARG CODEX_VERSION=latest
RUN npm install -g "@openai/codex@${CODEX_VERSION}" && npm cache clean --force
USER root
RUN ln -sf /usr/local/share/npm-global/bin/codex /usr/local/bin/codex
USER node
RUN mkdir -p /home/node/.codex

FROM base AS provider-gemini
ARG GEMINI_VERSION=latest
RUN npm install -g "@google/gemini-cli@${GEMINI_VERSION}" && npm cache clean --force
USER root
RUN ln -sf /usr/local/share/npm-global/bin/gemini /usr/local/bin/gemini
USER node
RUN mkdir -p /home/node/.gemini

FROM base AS provider-kilo
ARG KILO_VERSION=latest
RUN npm install -g "@kilocode/cli@${KILO_VERSION}" && npm cache clean --force
USER root
RUN ln -sf /usr/local/share/npm-global/bin/kilo /usr/local/bin/kilo
USER node
RUN mkdir -p /home/node/.config/kilo

FROM base AS provider-opencode
ARG OPENCODE_VERSION=latest
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force
USER root
RUN ln -sf /usr/local/share/npm-global/bin/opencode /usr/local/bin/opencode
USER node
RUN mkdir -p /home/node/.config/opencode /home/node/.local/share/opencode

FROM base AS provider-claude
ARG CLAUDE_CODE_VERSION=latest
# Anthropic deprecated npm installation for Claude Code; use the native
# installer so we stay aligned with supported distribution. Install from a
# small temporary directory to avoid known installer OOM failures in Docker.
#
# The binary is relocated from /home/node/.local/ to /usr/local/lib/claude/
# so it survives /home/node bind-mount overlays in controller-spawned workers.
USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /tmp/claude-install
RUN su -s /bin/bash node -c \
      "curl -fsSL https://claude.ai/install.sh | bash -s -- '${CLAUDE_CODE_VERSION}'" \
  && mkdir -p /usr/local/lib/claude \
  && mv "$(readlink -f /home/node/.local/bin/claude)" /usr/local/lib/claude/claude \
  && chmod 755 /usr/local/lib/claude/claude \
  && rm -rf /home/node/.local/share/claude /home/node/.local/bin/claude /tmp/claude-install \
  && ln -sf /usr/local/lib/claude/claude /usr/local/bin/claude
WORKDIR /home/node
USER node
RUN mkdir -p /home/node/.claude /home/node/.config/claude

FROM base AS provider-all
ARG CODEX_VERSION=latest
ARG GEMINI_VERSION=latest
ARG KILO_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g \
  "@openai/codex@${CODEX_VERSION}" \
  "@google/gemini-cli@${GEMINI_VERSION}" \
  "@kilocode/cli@${KILO_VERSION}" \
  "opencode-ai@${OPENCODE_VERSION}" \
  && npm cache clean --force
# Install claude as node user, then relocate the binary to a system path
# so it survives /home/node bind-mount overlays in controller-spawned workers.
# All /usr/local/bin symlinks are created here in one layer.
USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /tmp/claude-install
RUN su -s /bin/bash node -c \
      "curl -fsSL https://claude.ai/install.sh | bash -s -- '${CLAUDE_CODE_VERSION}'" \
  && mkdir -p /usr/local/lib/claude \
  && mv "$(readlink -f /home/node/.local/bin/claude)" /usr/local/lib/claude/claude \
  && chmod 755 /usr/local/lib/claude/claude \
  && rm -rf /home/node/.local/share/claude /home/node/.local/bin/claude /tmp/claude-install \
  && ln -sf /usr/local/lib/claude/claude /usr/local/bin/claude \
  && ln -sf /usr/local/share/npm-global/bin/codex /usr/local/bin/codex \
  && ln -sf /usr/local/share/npm-global/bin/gemini /usr/local/bin/gemini \
  && ln -sf /usr/local/share/npm-global/bin/kilo /usr/local/bin/kilo \
  && ln -sf /usr/local/share/npm-global/bin/opencode /usr/local/bin/opencode
WORKDIR /home/node
USER node
RUN mkdir -p \
  /home/node/.codex \
  /home/node/.gemini \
  /home/node/.claude \
  /home/node/.config/claude \
  /home/node/.config/kilo \
  /home/node/.config/opencode \
  /home/node/.local/share/opencode

# -----------------------------------------------------------------------------
# Runtime stage — selects a provider stage via the global PROVIDER arg.
# Default is `all` for backward compatibility with existing docker compose usage.
# Override: DOCKER_PROVIDER=claude docker compose build hivemoot-agent
# -----------------------------------------------------------------------------

# hadolint ignore=DL3006
FROM provider-${PROVIDER} AS runtime

# Persist the build-time PROVIDER as a runtime env so entrypoint.sh can
# detect mismatches between the baked image and AGENT_PROVIDER at startup.
# Global ARGs (before first FROM) are not visible in ENV instructions;
# re-declare here so Docker resolves the value into this stage.
ARG PROVIDER=all
ENV DOCKER_PROVIDER=${PROVIDER}

WORKDIR /workspace

COPY --chown=node:node cli /opt/hivemoot-agent/cli

RUN chmod +x /opt/hivemoot-agent/cli/hivemoot-agent

USER root
# WORKDIR /workspace above creates the dir owned by root even though
# USER=node was active at that point — on this Docker engine WORKDIR
# ignores the current USER and always uses root.  Chown it explicitly
# so agents running as node can write to cwd.  Without this,
# engine.py's _stage_workspace_agents_skills() raises PermissionError
# when it creates /workspace/.agents for workqueue-dispatched runs
# (github-mention / github-review-request / workqueue drain paths).
RUN ln -sf /opt/hivemoot-agent/cli/hivemoot-agent /usr/local/bin/hivemoot-agent \
  && chown node:node /workspace
USER node

# tini owns PID 1 and forwards signals to the CLI.  Default CMD is
# ``worker`` (oneshot) so a direct ``docker run hivemoot-agent:local``
# with no plugin config fails fast with a clear error instead of
# entering daemon mode and exiting 1 on "No triggers to run."
# Daemon-mode fleets opt in explicitly via compose
# (``command: ["run"]``) or an equivalent orchestrator override.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hivemoot-agent"]
CMD ["worker"]
