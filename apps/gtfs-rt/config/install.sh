#!/usr/bin/env bash
#
# install.sh — bootstrap a fresh Hetzner CX23 (Ubuntu 24.04+)
# to run @gtfs/rt as a systemd service under podman. Idempotent.
#
# The systemd unit does the runtime work: pulls the image on first
# start, restarts on crash, log-tees to journald. This script only
# installs the runtime + puts the unit + env file in place.
#
# Pre-reqs:
#   - root access on the host
#   - GITHUB_TOKEN env var set if the image is private
#
# Usage:
#   apt-get update && apt-get -y install git
#   git clone https://github.com/n3ary/gtfs-publisher.git
#   cd gtfs-publisher
#   bash apps/gtfs-rt/config/install.sh
#
# Then:
#   journalctl -u neary-gtfs-rt -f            # watch the service start
#   curl -sSf http://127.0.0.1/healthz        # smoke-test (host port 80)

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
CONFIG_DIR="$REPO_ROOT/apps/gtfs-rt/config"
SYSTEMD_DIR="/etc/systemd/system"
ENV_DIR="/etc/neary-gtfs"
ENV_FILE="$ENV_DIR/rt.env"
SERVICE_FILE="$SYSTEMD_DIR/neary-gtfs-rt.service"
SERVICE_NAME="neary-gtfs-rt"

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f "$CONFIG_DIR/neary-gtfs-rt.service" ] || { echo "missing $CONFIG_DIR/neary-gtfs-rt.service" >&2; exit 1; }

# 1. Container runtime
apt-get update -qq
apt-get install -y -qq podman

# 2. Service user + env dir
useradd --system --no-create-home --shell /usr/sbin/nologin neary-gtfs 2>/dev/null || true
install -d -m 0750 -o neary-gtfs -g neary-gtfs "$ENV_DIR"
[ -f "$ENV_FILE" ] || install -m 0640 -o neary-gtfs -g neary-gtfs \
  "$CONFIG_DIR/rt.env.example" "$ENV_FILE"

# 3. systemd unit
install -m 0644 "$CONFIG_DIR/neary-gtfs-rt.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

# 4. Optional: pre-login to ghcr.io so the first pull works
[ -n "${GITHUB_TOKEN:-}" ] && echo "$GITHUB_TOKEN" | podman login ghcr.io -u "${GITHUB_USER:-n3ary-ci}" --password-stdin

# 5. Smoke test
sleep 5
curl -sSf http://127.0.0.1/healthz >/dev/null \
  && echo "ok: /healthz responded on 127.0.0.1:80" \
  || { echo "warn: /healthz did not respond yet (the unit is still pulling/starting);"
       echo "       check 'journalctl -u $SERVICE_NAME -n 50'"; }

echo
echo "next steps:"
echo "  journalctl -u $SERVICE_NAME -f"
echo "  systemctl restart $SERVICE_NAME   # after a new image lands"
