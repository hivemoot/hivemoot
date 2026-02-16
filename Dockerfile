FROM node:24-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG CODEX_VERSION=latest
ARG GEMINI_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG HIVEMOOT_CLI_VERSION=latest

# Install system dependencies. gh is installed from GitHub's official apt repo
# because the Debian-packaged version is too old (2.23 vs 2.80+).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  git \
  gpg \
  jq \
  less \
  openssh-client \
  procps \
  ripgrep \
  tini \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && apt-get purge -y gpg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/share/npm-global \
  && chown -R node:node /usr/local/share/npm-global

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV HOME=/home/node
ENV PATH=/home/node/.local/bin:/usr/local/share/npm-global/bin:${PATH}

USER node

RUN npm install -g \
  "@openai/codex@${CODEX_VERSION}" \
  "@google/gemini-cli@${GEMINI_VERSION}" \
  "opencode-ai@${OPENCODE_VERSION}" \
  "@hivemoot-dev/cli@${HIVEMOOT_CLI_VERSION}" \
  && npm cache clean --force

# Anthropic deprecated npm installation for Claude Code; use the native
# installer so we stay aligned with supported distribution. Install from a
# small temporary directory to avoid known installer OOM failures in Docker.
WORKDIR /tmp/claude-install
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_CODE_VERSION}" \
  && rm -rf /tmp/claude-install \
  && mkdir -p /home/node/.codex /home/node/.gemini /home/node/.claude /home/node/.config/claude /home/node/.config/opencode /home/node/.local/share/opencode

USER root

# Login shells (e.g. `bash -lc` used by agent task commands) do not always
# include the npm-global prefix path. Mirror tool shims into /usr/local/bin
# so codex/gemini/claude/hivemoot stay discoverable.
RUN ln -sf /usr/local/share/npm-global/bin/codex /usr/local/bin/codex \
  && ln -sf /usr/local/share/npm-global/bin/gemini /usr/local/bin/gemini \
  && ln -sf /usr/local/share/npm-global/bin/opencode /usr/local/bin/opencode \
  && ln -sf /home/node/.local/bin/claude /usr/local/bin/claude \
  && ln -sf /usr/local/share/npm-global/bin/hivemoot /usr/local/bin/hivemoot

USER node

WORKDIR /workspace

COPY --chown=node:node scripts /opt/hivemoot-agent/scripts
COPY --chown=node:node prompts /opt/hivemoot-agent/prompts

RUN chmod +x /opt/hivemoot-agent/scripts/*.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/hivemoot-agent/scripts/entrypoint.sh"]
