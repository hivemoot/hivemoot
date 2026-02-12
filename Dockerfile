FROM node:20-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG CODEX_VERSION=latest
ARG GEMINI_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG HIVEMOOT_CLI_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  gh \
  git \
  jq \
  less \
  openssh-client \
  procps \
  ripgrep \
  tini \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/share/npm-global \
  && chown -R node:node /usr/local/share/npm-global

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=/usr/local/share/npm-global/bin:${PATH}
ENV HOME=/home/node

USER node

RUN npm install -g \
  "@openai/codex@${CODEX_VERSION}" \
  "@google/gemini-cli@${GEMINI_VERSION}" \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@hivemoot-dev/cli@${HIVEMOOT_CLI_VERSION}" \
  && npm cache clean --force \
  && mkdir -p /home/node/.codex /home/node/.gemini /home/node/.claude /home/node/.config/claude

USER root

# Login shells (e.g. `bash -lc` used by agent task commands) do not always
# include the npm-global prefix path. Mirror tool shims into /usr/local/bin
# so codex/gemini/claude/hivemoot stay discoverable.
RUN ln -sf /usr/local/share/npm-global/bin/codex /usr/local/bin/codex \
  && ln -sf /usr/local/share/npm-global/bin/gemini /usr/local/bin/gemini \
  && ln -sf /usr/local/share/npm-global/bin/claude /usr/local/bin/claude \
  && ln -sf /usr/local/share/npm-global/bin/hivemoot /usr/local/bin/hivemoot

USER node

WORKDIR /workspace

COPY --chown=node:node scripts /opt/hivemoot-agent/scripts
COPY --chown=node:node prompts /opt/hivemoot-agent/prompts

RUN chmod +x /opt/hivemoot-agent/scripts/*.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/hivemoot-agent/scripts/entrypoint.sh"]
