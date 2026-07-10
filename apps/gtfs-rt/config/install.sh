#!/usr/bin/env bash
# install.sh -- bootstrap a fresh Hetzner CX23 to run @gtfs/rt under podman.
# The systemd unit does the runtime work; this script only installs the
# runtime + puts the unit + env in place. Idempotent.

set -euo pipefail

# install.sh can run two ways:
#   1. from inside a clone of the repo (REPO_ROOT exported) - the
#      config files are in $REPO_ROOT/apps/gtfs-rt/config
#   2. as a standalone bundle: this script + the systemd unit + the
#      healthcheck files + rt.env.example, all in the same directory,
#      dropped onto a fresh VM by the rebuild-gtfs-rt-vm workflow
#      via `curl .../config/{file}` (PR #149). The 3-level-up
#      heuristic that the original script used here resolves to the
#      filesystem root in that case, and the config-file preflight
#      checks fail. When REPO_ROOT is unset, fall back to the
#      script's own directory.
if [ -n "${REPO_ROOT:-}" ]; then
  CONFIG_DIR="$REPO_ROOT/apps/gtfs-rt/config"
else
  CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
SYSTEMD_DIR="/etc/systemd/system"
ENV_DIR="/etc/neary-gtfs"
ENV_FILE="$ENV_DIR/rt.env"
SERVICE_FILE="$SYSTEMD_DIR/neary-gtfs-rt.service"
SERVICE_NAME="neary-gtfs-rt"
HEALTHCHECK_BIN="/usr/local/bin/neary-gtfs-rt-healthcheck.sh"
HEALTHCHECK_TIMER="$SYSTEMD_DIR/neary-gtfs-rt-healthcheck.timer"
HEALTHCHECK_SERVICE="$SYSTEMD_DIR/neary-gtfs-rt-healthcheck.service"

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f "$CONFIG_DIR/neary-gtfs-rt.service" ] || { echo "missing $CONFIG_DIR/neary-gtfs-rt.service" >&2; exit 1; }
[ -f "$CONFIG_DIR/neary-gtfs-rt-healthcheck.sh" ] || { echo "missing $CONFIG_DIR/neary-gtfs-rt-healthcheck.sh" >&2; exit 1; }
[ -f "$CONFIG_DIR/neary-gtfs-rt-healthcheck.service" ] || { echo "missing $CONFIG_DIR/neary-gtfs-rt-healthcheck.service" >&2; exit 1; }
[ -f "$CONFIG_DIR/neary-gtfs-rt-healthcheck.timer" ] || { echo "missing $CONFIG_DIR/neary-gtfs-rt-healthcheck.timer" >&2; exit 1; }

cat <<'USAGE'
Prereqs: root, optionally GITHUB_TOKEN for private images.
After:   journalctl -u neary-gtfs-rt -f
         curl -sSf http://127.0.0.1/healthz
USAGE

apt-get update -qq
apt-get install -y -qq podman

useradd --system --no-create-home --shell /usr/sbin/nologin neary-gtfs 2>/dev/null || true
install -d -m 0750 -o neary-gtfs -g neary-gtfs "$ENV_DIR"
[ -f "$ENV_FILE" ] || install -m 0640 -o neary-gtfs -g neary-gtfs \
  "$CONFIG_DIR/rt.env.example" "$ENV_FILE"

install -m 0644 "$CONFIG_DIR/neary-gtfs-rt.service" "$SERVICE_FILE"
install -m 0755 "$CONFIG_DIR/neary-gtfs-rt-healthcheck.sh" "$HEALTHCHECK_BIN"
install -m 0644 "$CONFIG_DIR/neary-gtfs-rt-healthcheck.service" "$HEALTHCHECK_SERVICE"
install -m 0644 "$CONFIG_DIR/neary-gtfs-rt-healthcheck.timer" "$HEALTHCHECK_TIMER"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl enable --now neary-gtfs-rt-healthcheck.timer

# Pre-login so the first podman pull inside ExecStart doesn't 401.
[ -n "${GITHUB_TOKEN:-}" ] && echo "$GITHUB_TOKEN" | podman login ghcr.io -u "${GITHUB_USER:-n3ary-ci}" --password-stdin

# Make sure unattended security updates are on. The host doesn't
# have many packages, but unattended-upgrades catches the podman /
# openssh CVEs that show up over time. unattended-upgrades is in
# the default ubuntu-26.04 install; install.sh only enables + sets
# the auto-update window if it isn't already.
if command -v unattended-upgrade >/dev/null 2>&1; then
  dpkg-reconfigure -f noninteractive --priority=medium unattended-upgrades 2>/dev/null || true
fi

sleep 5
curl -sSf http://127.0.0.1/healthz >/dev/null \
  && echo "ok: /healthz responded on 127.0.0.1:80" \
  || { echo "warn: /healthz did not respond yet (the unit is still pulling/starting);"
       echo "       check 'journalctl -u $SERVICE_NAME -n 50'"; }

echo
echo "next steps:"
echo "  journalctl -u $SERVICE_NAME -f"
echo "  systemctl restart $SERVICE_NAME                  # after a new image lands"
echo "  systemctl list-timers neary-gtfs-rt-healthcheck # verify hourly probe is scheduled"