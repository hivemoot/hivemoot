#!/usr/bin/env bash
# apiarist host installer — idempotent.
#
# Provisions a Hive host (Ubuntu 24.04) to run the apiarist daemon as
# systemd unit `apiarist.service`. Designed to be re-run for upgrades
# without manual cleanup steps in between.
#
# Usage (run from the apiarist source root, i.e. where pyproject.toml lives):
#
#   sudo ./deploy/install.sh                                      # uses defaults
#   sudo ./deploy/install.sh --secrets /opt/apiary/apiary.secrets.yaml
#   sudo ./deploy/install.sh --apiarist-token "hm_xxx"            # explicit token
#
# What it does (in order, each step idempotent):
#
#   1. Pre-flight checks — root, Python 3.11+, agent group, source layout
#   2. Create user/group `apiarist` if missing (system account, no shell)
#   3. Ensure `apiarist` user is a member of `agent` group (so daemon can
#      chgrp the socket file to agent at startup — see DESIGN.md §10)
#   4. Build Python venv at /opt/apiarist/venv, pip install the source
#   5. Symlink /usr/local/bin/apiarist → /opt/apiarist/venv/bin/apiarist
#   6. Stage /etc/apiarist/apiarist.yaml + /etc/apiarist/agent-token.env
#      (the env file gets the bearer token from apiary.secrets.yaml's
#      `health_token` field, mode 0640 root:apiarist)
#   7. Copy systemd/apiarist.service into /etc/systemd/system/
#   8. systemctl daemon-reload + enable + restart
#   9. Verify socket appears at /run/apiarist/apiarist.sock with
#      apiarist:agent ownership and mode 0660
#
# Failure modes:
#   - Missing dependency → exits with the install command needed
#   - Bad/missing token → refuses to write empty env file
#   - Daemon doesn't come up → tail of journalctl + exit 1

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — change here, not at the call site.
# ---------------------------------------------------------------------------

readonly APIARIST_USER="apiarist"
readonly APIARIST_GROUP="apiarist"
readonly AGENT_GROUP="agent"
readonly INSTALL_DIR="/opt/apiarist"
readonly VENV_DIR="${INSTALL_DIR}/venv"
readonly BIN_LINK="/usr/local/bin/apiarist"
readonly CONFIG_DIR="/etc/apiarist"
readonly CONFIG_FILE="${CONFIG_DIR}/apiarist.yaml"
readonly TOKEN_ENV_FILE="${CONFIG_DIR}/agent-token.env"
readonly SYSTEMD_UNIT_DEST="/etc/systemd/system/apiarist.service"
readonly SOCKET_PATH="/run/apiarist/apiarist.sock"
readonly DEFAULT_SECRETS_FILE="/opt/apiary/apiary.secrets.yaml"
readonly REQUIRED_PYTHON_MAJOR_MINOR="3.11"

# Resolved at parse time.
SECRETS_FILE="${DEFAULT_SECRETS_FILE}"
EXPLICIT_TOKEN=""

# ---------------------------------------------------------------------------
# Output helpers — one place to switch tone if we ever want a quieter mode.
# ---------------------------------------------------------------------------

step()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
warn()  { printf '\033[1;33m    WARN: %s\033[0m\n' "$*" >&2; }
fatal() { printf '\033[1;31m    ERROR: %s\033[0m\n' "$*" >&2; exit 1; }
ok()    { printf '\033[1;32m    OK: %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# Argument parsing.
# ---------------------------------------------------------------------------

print_usage() {
    sed -n '2,30p' "$0" | sed 's|^#||; s|^ ||'
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --secrets) SECRETS_FILE="$2"; shift 2 ;;
            --apiarist-token) EXPLICIT_TOKEN="$2"; shift 2 ;;
            -h|--help) print_usage; exit 0 ;;
            *) fatal "unknown argument: $1 (try --help)" ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# Pre-flight checks — fail fast with actionable messages.
# ---------------------------------------------------------------------------

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        fatal "must be run as root (try: sudo $0)"
    fi
}

require_python() {
    local version
    if ! version=$(python3 --version 2>&1); then
        fatal "python3 not installed; run: apt-get install python3 python3-venv"
    fi
    # Format: "Python 3.12.3" → split on space, take field 2, take major.minor
    local mm
    mm=$(printf '%s' "${version}" | awk '{print $2}' | cut -d. -f1,2)
    # Lexicographic comparison works for X.Y where Y is single-digit; for the
    # 3.10/3.11/3.12 range we need numeric. Use python itself to compare.
    if ! python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"; then
        fatal "need Python ${REQUIRED_PYTHON_MAJOR_MINOR}+, found ${mm}; upgrade or set up a 3.11+ interpreter"
    fi
    # Debian/Ubuntu ship `venv` as a separate package — `python3 -m venv`
    # silently produces a broken venv (no pip) without it. Catch the
    # missing module up front rather than fail mid-install.
    if ! python3 -c "import ensurepip" 2>/dev/null; then
        fatal "python3-venv (ensurepip) missing; run: apt-get install python3-venv"
    fi
    info "python3: ${version} (${mm}, venv module present)"
}

require_agent_group() {
    if ! getent group "${AGENT_GROUP}" >/dev/null; then
        fatal "group '${AGENT_GROUP}' does not exist — apiary deploy must run first to create it (sudo /opt/apiary/deploy-apiary.sh)"
    fi
    info "agent group: present"
}

require_source_layout() {
    if [[ ! -f "pyproject.toml" ]]; then
        fatal "must be run from the apiarist source root (couldn't find ./pyproject.toml in $(pwd))"
    fi
    if [[ ! -f "systemd/apiarist.service" ]]; then
        fatal "systemd/apiarist.service not found; expected to be next to pyproject.toml"
    fi
    info "source layout: pyproject.toml + systemd/apiarist.service present"
}

require_yq() {
    if ! command -v yq >/dev/null; then
        fatal "yq not installed (needed to extract token from ${SECRETS_FILE}); apt-get install yq or download from github.com/mikefarah/yq"
    fi
    info "yq: $(yq --version 2>&1 | head -1)"
}

# ---------------------------------------------------------------------------
# Step 1 — User and group.
# ---------------------------------------------------------------------------

create_user_and_group() {
    step "Ensure apiarist user/group exists"

    if getent group "${APIARIST_GROUP}" >/dev/null; then
        info "group ${APIARIST_GROUP}: already exists"
    else
        groupadd --system "${APIARIST_GROUP}"
        ok "group ${APIARIST_GROUP}: created"
    fi

    if getent passwd "${APIARIST_USER}" >/dev/null; then
        info "user ${APIARIST_USER}: already exists"
    else
        useradd --system \
                --gid "${APIARIST_GROUP}" \
                --home-dir /var/lib/apiarist \
                --no-create-home \
                --shell /sbin/nologin \
                --comment "apiarist daemon (Hivemoot host-side broker)" \
                "${APIARIST_USER}"
        ok "user ${APIARIST_USER}: created (system, no shell, no home)"
    fi
}

add_apiarist_to_agent_group() {
    step "Ensure ${APIARIST_USER} is a member of ${AGENT_GROUP}"

    # `id -nG <user>` lists groups separated by spaces; -w matches whole words
    # to avoid partial matches like 'agentX' satisfying a check for 'agent'.
    if id -nG "${APIARIST_USER}" | tr ' ' '\n' | grep -wq "${AGENT_GROUP}"; then
        info "already in ${AGENT_GROUP}"
    else
        # `usermod -aG` appends; without -a it would replace all supplementary
        # groups, which would silently break other memberships if they exist.
        usermod -aG "${AGENT_GROUP}" "${APIARIST_USER}"
        ok "added to ${AGENT_GROUP} (daemon can now chgrp the socket)"
    fi
}

# ---------------------------------------------------------------------------
# Step 2 — Python package install.
# ---------------------------------------------------------------------------

install_python_package() {
    step "Install apiarist Python package into ${VENV_DIR}"

    mkdir -p "${INSTALL_DIR}"

    # Recreate venv every install for a deterministic upgrade path. Cost is
    # ~5s of pip download/install; benefit is no leftover packages from a
    # previous version's dependencies. The venv is opaque to systemd, so
    # the brief absence between rm and python -m venv is invisible to it
    # (we're about to restart the unit anyway).
    if [[ -d "${VENV_DIR}" ]]; then
        info "removing existing venv (clean upgrade)"
        rm -rf "${VENV_DIR}"
    fi

    python3 -m venv "${VENV_DIR}"
    info "venv created"

    # --upgrade pip first so the install uses modern resolver behavior.
    "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
    "${VENV_DIR}/bin/pip" install --quiet .
    info "pip install: complete"

    if [[ ! -x "${VENV_DIR}/bin/apiarist" ]]; then
        fatal "expected ${VENV_DIR}/bin/apiarist after pip install — pyproject.toml console_scripts may be missing"
    fi
    ok "apiarist binary at ${VENV_DIR}/bin/apiarist"

    # Symlink to /usr/local/bin so the systemd unit's ExecStart finds it
    # at the canonical path. Use ln -sf for idempotency (replaces an
    # existing link, idempotent on first run).
    ln -sf "${VENV_DIR}/bin/apiarist" "${BIN_LINK}"
    ok "${BIN_LINK} → ${VENV_DIR}/bin/apiarist"
}

# ---------------------------------------------------------------------------
# Step 3 — Configuration staging.
# ---------------------------------------------------------------------------

stage_config_dir() {
    step "Stage ${CONFIG_DIR}"
    install -d -o root -g "${APIARIST_GROUP}" -m 0750 "${CONFIG_DIR}"
    ok "${CONFIG_DIR} (root:${APIARIST_GROUP} 0750)"
}

stage_apiarist_yaml() {
    # The unit passes --socket-group=agent on ExecStart, so this file is
    # mostly for documentation + future operator overrides. It MUST exist
    # because the unit references it via --config.
    if [[ -f "${CONFIG_FILE}" ]]; then
        info "${CONFIG_FILE}: already present (preserving operator changes)"
        return
    fi

    cat > "${CONFIG_FILE}" <<'YAML'
# apiarist runtime config (DESIGN.md §9).
#
# This file is staged by deploy/install.sh on first install and not
# overwritten on re-install — operator overrides are preserved.
#
# Note: systemd unit's ExecStart passes --socket-group=agent, which
# trumps anything set here (CLI > env > file > defaults). The
# socket_group entry below is documentation; the daemon's effective
# group is whatever the unit's ExecStart specifies.
log_level: info
backend_url: https://www.hivemoot.dev
socket_group: agent           # documentation — unit passes via CLI
YAML
    chown "root:${APIARIST_GROUP}" "${CONFIG_FILE}"
    chmod 0640 "${CONFIG_FILE}"
    ok "${CONFIG_FILE} (root:${APIARIST_GROUP} 0640)"
}

stage_agent_token_env() {
    step "Stage ${TOKEN_ENV_FILE} (agent token for backend auth)"

    local token=""
    if [[ -n "${EXPLICIT_TOKEN}" ]]; then
        token="${EXPLICIT_TOKEN}"
        info "using explicit --apiarist-token from CLI"
    else
        if [[ ! -r "${SECRETS_FILE}" ]]; then
            fatal "secrets file ${SECRETS_FILE} not readable; pass --secrets <path> or --apiarist-token <hm_xxx>"
        fi
        require_yq
        # `health_token` is the V1 agent-token field per DESIGN.md §9 (multi-
        # token migration deferred). The yq output `null` when the field is
        # missing — guard against writing "null" into the env file.
        token=$(yq -r '.health_token // ""' "${SECRETS_FILE}")
        if [[ -z "${token}" || "${token}" == "null" ]]; then
            fatal "field 'health_token' missing or empty in ${SECRETS_FILE}; can't continue"
        fi
        info "extracted health_token from ${SECRETS_FILE}"
    fi

    # Atomic write: temp file in target dir, chmod, chown, then mv. Avoids
    # the daemon (already running, mid-restart) reading a half-written file.
    local tmp
    tmp=$(mktemp -p "${CONFIG_DIR}" agent-token.env.XXXXXX)
    # shellcheck disable=SC2016
    printf 'APIARIST_AGENT_TOKEN=%s\n' "${token}" > "${tmp}"
    chown "root:${APIARIST_GROUP}" "${tmp}"
    chmod 0640 "${tmp}"
    mv "${tmp}" "${TOKEN_ENV_FILE}"
    ok "${TOKEN_ENV_FILE} (root:${APIARIST_GROUP} 0640, ${#token} bytes token)"
}

# ---------------------------------------------------------------------------
# Step 4 — Systemd unit + start.
# ---------------------------------------------------------------------------

install_systemd_unit() {
    step "Install systemd unit"
    install -m 0644 systemd/apiarist.service "${SYSTEMD_UNIT_DEST}"
    ok "${SYSTEMD_UNIT_DEST}"
}

reload_and_start() {
    step "Reload systemd + enable + restart apiarist"
    systemctl daemon-reload
    info "daemon-reload: done"
    systemctl enable apiarist.service >/dev/null 2>&1
    info "enabled (will start at boot)"
    # `restart` is the right verb for both first install (starts) and
    # upgrade (restarts to pick up new code). Idempotent.
    systemctl restart apiarist.service
    ok "restarted"
}

# ---------------------------------------------------------------------------
# Step 5 — Post-install verification.
# ---------------------------------------------------------------------------

verify_install() {
    step "Verify install"

    # Give the daemon a moment to bind the socket. The bind happens early in
    # startup — well under a second on a healthy host — but systemd's "active"
    # state can flip a hair before the bind completes.
    local tries=0
    while (( tries < 20 )); do
        if [[ -S "${SOCKET_PATH}" ]]; then
            break
        fi
        sleep 0.25
        tries=$((tries + 1))
    done

    if ! systemctl is-active --quiet apiarist.service; then
        warn "apiarist.service is NOT active — recent journal:"
        journalctl -u apiarist.service -n 30 --no-pager >&2
        fatal "daemon failed to start; see above"
    fi
    ok "apiarist.service: active"

    if [[ ! -S "${SOCKET_PATH}" ]]; then
        fatal "socket ${SOCKET_PATH} did not appear within 5s; check journal: journalctl -u apiarist -n 50"
    fi

    local owner mode
    # `stat -c '%U:%G %a'` formats as "user:group mode-octal".
    owner=$(stat -c '%U:%G' "${SOCKET_PATH}")
    mode=$(stat -c '%a' "${SOCKET_PATH}")
    if [[ "${owner}" != "${APIARIST_USER}:${AGENT_GROUP}" ]]; then
        fatal "socket ownership wrong: expected ${APIARIST_USER}:${AGENT_GROUP}, got ${owner}"
    fi
    if [[ "${mode}" != "660" ]]; then
        fatal "socket mode wrong: expected 660, got ${mode}"
    fi
    ok "socket ${SOCKET_PATH} (${owner} ${mode})"

    # One more sanity step: make sure the daemon registered its ops. The
    # startup log line includes an ops list per server.py:147.
    if journalctl -u apiarist.service -n 200 --no-pager | grep -q '"uds server bound"'; then
        ok "daemon emitted 'uds server bound' log entry"
    else
        warn "did not see 'uds server bound' in recent journal — daemon may still be starting"
    fi

    info ""
    info "Next: tail logs with"
    info "  journalctl -u apiarist.service -f"
    info "Probe the socket as a member of group '${AGENT_GROUP}' with"
    info "  echo '{\"op\":\"health\",\"request_id\":\"probe\"}' | socat - UNIX-CONNECT:${SOCKET_PATH}"
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------

main() {
    parse_args "$@"

    step "Pre-flight checks"
    require_root
    require_python
    require_agent_group
    require_source_layout

    create_user_and_group
    add_apiarist_to_agent_group

    install_python_package

    stage_config_dir
    stage_apiarist_yaml
    stage_agent_token_env

    install_systemd_unit
    reload_and_start

    verify_install

    step "Install complete"
}

main "$@"
