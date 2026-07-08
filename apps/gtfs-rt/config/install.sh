#!/usr/bin/env bash
#
# install.sh — bootstrap a fresh Hetzner CX23 (Ubuntu 24.04+) to
# run @gtfs/rt as a systemd service under podman. Idempotent: re-run
# after a Containerfile change to pick up the latest image.
#
# This is the operator-facing entry point for the Hetzner deploy.
# Lives in apps/gtfs-rt/config/ so the install config is versioned
# with the artifact it installs.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
APPS_DIR="$REPO_ROOT/apps/gtfs-rt"
CONFIG_DIR="$APPS_DIR/config"
SYSTEMD_DIR="/etc/systemd/system"
ENV_DIR="/etc/neary-gtfs"
ENV_FILE="$ENV_DIR/rt.env"
SERVICE_FILE="$SYSTEMD_DIR/neary-gtfs-rt.service"
SERVICE_NAME="neary-gtfs-rt"
IMAGE="${IMAGE:-ghcr.io/n3ary/gtfs-rt:latest}"
DNAT_SCRIPT="/usr/local/sbin/dnat-80-to-8080.sh"
DNAT_SERVICE_FILE="$SYSTEMD_DIR/dnat-80-to-8080.service"

if [ -t 1 ]; then
  C_OK='\033[0;32m'; C_WARN='\033[0;33m'; C_ERR='\033[0;31m'; C_RESET='\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_RESET=''
fi
log()  { printf "${C_OK}[install]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_WARN}[install]${C_RESET} %s\n" "$*" >&2; }
die()  { printf "${C_ERR}[install]${C_RESET} %s\n" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"
[ -d "$REPO_ROOT" ] || die "REPO_ROOT=$REPO_ROOT does not exist"
[ -f "$CONFIG_DIR/neary-gtfs-rt.service" ] || die "missing $CONFIG_DIR/neary-gtfs-rt.service"

# --- podman ---
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq podman
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y podman
else
  die "no apt-get or dnf — adapt install.sh for this distro"
fi
podman --version

# --- system user + env dir ---
if ! id neary-gtfs >/dev/null 2>&1; then
  log "creating neary-gtfs system user"
  useradd --system --no-create-home --shell /usr/sbin/nologin neary-gtfs
fi
install -d -m 0750 -o neary-gtfs -g neary-gtfs "$ENV_DIR"

if [ ! -f "$ENV_FILE" ]; then
  log "creating $ENV_FILE from rt.env.example"
  install -m 0640 -o neary-gtfs -g neary-gtfs \
    "$CONFIG_DIR/rt.env.example" "$ENV_FILE"
  warn "edit $ENV_FILE to set ENABLED_FEEDS and any overrides, then re-run this script"
else
  log "$ENV_FILE already exists — leaving untouched"
fi

# --- systemd units ---
log "installing systemd unit to $SERVICE_FILE"
install -m 0644 "$CONFIG_DIR/neary-gtfs-rt.service" "$SERVICE_FILE"
systemctl daemon-reload

# --- iptables DNAT (the operator file lives in ops/hetzner/) ---
OPS_HETZNER_DIR="$REPO_ROOT/ops/hetzner"
if [ -f "$OPS_HETZNER_DIR/dnat-80-to-8080.sh" ]; then
  log "installing DNAT script to $DNAT_SCRIPT"
  install -d -m 0755 /usr/local/sbin
  install -m 0755 "$OPS_HETZNER_DIR/dnat-80-to-8080.sh" "$DNAT_SCRIPT"
  if [ -f "$OPS_HETZNER_DIR/dnat-80-to-8080.service" ]; then
    install -m 0644 "$OPS_HETZNER_DIR/dnat-80-to-8080.service" "$DNAT_SERVICE_FILE"
    systemctl enable --now dnat-80-to-8080.service
  fi
else
  warn "no ops/hetzner/dnat-80-to-8080.sh found; port 80 not redirected to 8080"
  warn "Cloudflare orange-cloud proxy will fail until this is set up"
fi

# --- GHCR auth ---
if ! podman image exists "$IMAGE" 2>/dev/null; then
  if [ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
    log "logging in to ghcr.io with GITHUB_TOKEN env var"
    echo "$GITHUB_TOKEN" | podman login ghcr.io -u "${GITHUB_USER:-n3ary-ci}" --password-stdin
  elif [ -f "$HOME/.config/containers/auth.json" ]; then
    log "using existing $HOME/.config/containers/auth.json for ghcr.io"
  else
    warn "no GHCR auth configured; pull may 401 for private images"
    warn "set GITHUB_TOKEN and GITHUB_USER, or pre-pull with podman login"
  fi
fi

log "pulling $IMAGE"
podman pull "$IMAGE"

log "enabling + starting $SERVICE_NAME"
systemctl enable --now "$SERVICE_NAME"

sleep 5
if curl -sSf http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
  log "service is up — /healthz responded"
  echo
  log "next steps:"
  echo "  journalctl -u $SERVICE_NAME -f"
  echo "  systemctl restart $SERVICE_NAME   # after a new image lands"
  echo "  podman logs -f $SERVICE_NAME      # in addition to journald"
else
  warn "service did not respond on :8080 within 5 s"
  warn "  journalctl -u $SERVICE_NAME -n 50 --no-pager"
  exit 1
fi
