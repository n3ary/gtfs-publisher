#!/usr/bin/env bash
#
# install.sh — bootstrap a fresh Hetzner CX23 (or any Ubuntu 24.04+)
# to run @gtfs/rt as a systemd service under podman. Idempotent.
#
# Everything below the system unit line is the systemd unit's
# job: it pulls the image on first start, restarts on crash, and
# log-tees to journald. This script's only job is to put the
# files in the right place and turn the unit on.
#
# Pre-reqs (caller's job):
#   - root access on the host
#   - `apt-get` (Debian/Ubuntu) or `dnf` (RHEL/Fedora)
#   - GITHUB_TOKEN env var set if the image is private
#
# Usage:
#   apt-get update && apt-get -y install git
#   git clone https://github.com/n3ary/gtfs-publisher.git
#   cd gtfs-publisher
#   bash apps/gtfs-rt/config/install.sh
#
# Then:
#   journalctl -u neary-gtfs-rt -f   # watch the service start
#   curl -sSf http://127.0.0.1:8080/healthz  # smoke-test

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
CONFIG_DIR="$REPO_ROOT/apps/gtfs-rt/config"
OPS_HETZNER_DIR="$REPO_ROOT/ops/hetzner"
SYSTEMD_DIR="/etc/systemd/system"
ENV_DIR="/etc/neary-gtfs"
ENV_FILE="$ENV_DIR/rt.env"
SERVICE_FILE="$SYSTEMD_DIR/neary-gtfs-rt.service"
SERVICE_NAME="neary-gtfs-rt"

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f "$CONFIG_DIR/neary-gtfs-rt.service" ] || { echo "missing $CONFIG_DIR/neary-gtfs-rt.service" >&2; exit 1; }

# 1. Container runtime
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq podman
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y podman
else
  echo "no apt-get or dnf — adapt install.sh for this distro" >&2
  exit 1
fi

# 2. Service user + env dir
useradd --system --no-create-home --shell /usr/sbin/nologin neary-gtfs 2>/dev/null || true
install -d -m 0750 -o neary-gtfs -g neary-gtfs "$ENV_DIR"
[ -f "$ENV_FILE" ] || install -m 0640 -o neary-gtfs -g neary-gtfs \
  "$CONFIG_DIR/rt.env.example" "$ENV_FILE"

# 3. systemd unit
install -m 0644 "$CONFIG_DIR/neary-gtfs-rt.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

# 4. Port 80 -> 8080 DNAT (separate from the app, lives in ops/hetzner/)
[ -f "$OPS_HETZNER_DIR/dnat-80-to-8080.sh" ] || {
  echo "warning: $OPS_HETZNER_DIR/dnat-80-to-8080.sh not found;"
  echo "         CF orange-cloud proxy will 521 until you set it up." >&2
}
[ -f "$OPS_HETZNER_DIR/dnat-80-to-8080.sh" ] && {
  install -d -m 0755 /usr/local/sbin
  install -m 0755 "$OPS_HETZNER_DIR/dnat-80-to-8080.sh" /usr/local/sbin/dnat-80-to-8080.sh
  install -m 0644 "$OPS_HETZNER_DIR/dnat-80-to-8080.service" "$SYSTEMD_DIR/dnat-80-to-8080.service"
  systemctl enable --now dnat-80-to-8080.service
}

# 5. Optional: pre-login to ghcr.io so the first pull works
[ -n "${GITHUB_TOKEN:-}" ] && echo "$GITHUB_TOKEN" | podman login ghcr.io -u "${GITHUB_USER:-n3ary-ci}" --password-stdin

# 6. Smoke test (the unit's ExecStart pre-pulled the image, so this
#    only confirms the service is up; if 5 s isn't enough, the
#    unit's Restart=on-failure will keep retrying)
sleep 5
curl -sSf http://127.0.0.1:8080/healthz >/dev/null \
  && echo "ok: /healthz responded on 127.0.0.1:8080" \
  || { echo "warn: /healthz did not respond yet (the unit is still pulling/starting);"
       echo "       check 'journalctl -u $SERVICE_NAME -n 50'"; }

echo
echo "next steps:"
echo "  journalctl -u $SERVICE_NAME -f"
echo "  systemctl restart $SERVICE_NAME   # after a new image lands"
