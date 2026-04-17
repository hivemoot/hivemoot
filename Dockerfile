# Global build arg — controls which provider stage becomes the runtime image.
# Must be at global scope (before first FROM) to be usable in FROM directives.
# Values: all | codex | gemini | kilo | opencode | claude
ARG PROVIDER=all
ARG GH_VERSION=2.89.0

FROM golang:1.26.2-bookworm AS gh-builder

ARG GH_VERSION
RUN GOBIN=/tmp/gh-bin go install github.com/cli/cli/v2/cmd/gh@v${GH_VERSION}

FROM node:24-slim AS base

ARG DEBIAN_FRONTEND=noninteractive
ARG NPM_VERSION=11.11.1
ARG HIVEMOOT_CLI_VERSION=latest

# Install system dependencies. Build gh from source with a patched Go toolchain
# until the upstream apt package stops shipping a vulnerable Go stdlib.
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
  ripgrep \
  tini \
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

# Install hivemoot CLI in the base stage — needed in every provider variant.
RUN npm install -g "@hivemoot-dev/cli@${HIVEMOOT_CLI_VERSION}" \
  && npm cache clean --force

USER root

RUN ln -sf /usr/local/share/npm-global/bin/hivemoot /usr/local/bin/hivemoot

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

COPY --chown=node:node worker /opt/hivemoot-agent/worker
COPY --chown=node:node shared /opt/hivemoot-agent/shared
COPY --chown=node:node identities /opt/hivemoot-agent/identities
COPY --chown=node:node integrations /opt/hivemoot-agent/integrations
COPY --chown=node:node cli /opt/hivemoot-agent/cli

RUN find /opt/hivemoot-agent/worker -name '*.sh' -exec chmod +x {} + \
  && find /opt/hivemoot-agent/shared -name '*.sh' -exec chmod +x {} + \
  && find /opt/hivemoot-agent/identities -name '*.sh' -exec chmod +x {} + \
  && find /opt/hivemoot-agent/integrations -name '*.sh' -exec chmod +x {} + \
  && chmod +x /opt/hivemoot-agent/cli/hivemoot-agent

USER root
RUN ln -sf /opt/hivemoot-agent/cli/hivemoot-agent /usr/local/bin/hivemoot-agent
USER node

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/hivemoot-agent/worker/entrypoint.sh"]
