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

# Pre-login so the first podman pull inside ExecStart doesn't 401.
# MUST happen BEFORE `systemctl enable --now $SERVICE_NAME` - the
# unit's ExecStart pulls ghcr.io/n3ary/gtfs-rt:latest on first
# start, and without auth the pull 401s and the unit restart-loops
# until the login catches up. The pre-PR-#153 ordering had this
# block AFTER `systemctl enable --now`, which is the classic race.
# Uses GHCR_TOKEN / GHCR_USER to match the names in
# deploy-gtfs-rt.yml so the same secret + the same credentials
# work in both flows.
[ -n "${GHCR_TOKEN:-}" ] && echo "$GHCR_TOKEN" | podman login ghcr.io -u "${GHCR_USER:-ciotlosm}" --password-stdin

systemctl enable --now "$SERVICE_NAME"
systemctl enable --now neary-gtfs-rt-healthcheck.timer

# Make sure unattended security updates are on. The host doesn't
# have many packages, but unattended-upgrades catches the podman /
# openssh CVEs that show up over time. unattended-upgrades is in
# the default ubuntu-26.04 install; install.sh only enables + sets
# the auto-update window if it isn't already.
if command -v unattended-upgrade >/dev/null 2>&1; then
  dpkg-reconfigure -f noninteractive --priority=medium unattended-upgrades 2>/dev/null || true
fi

# Wait for the unit to actually be healthy. The unit pulls
# ghcr.io/n3ary/gtfs-rt on first start, which can take 1-3 min
# on a slow connection, so the bootstrap call that fires
# straight after `systemctl enable --now` is meaningless. Poll up
# to 5 minutes. If the unit never becomes healthy, exit 1 - this
# is a real bootstrap failure and the operator should hear about
# it, not have to read a journal to find out.
HEALTH_OK=0
for i in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1/healthz >/dev/null 2>&1; then
    echo "ok: /healthz 200 on 127.0.0.1:80 after ${i} attempts"
    HEALTH_OK=1
    break
  fi
  sleep 5
done
if [ "$HEALTH_OK" = "0" ]; then
  echo "::error::neary-gtfs-rt unit did not become healthy within 5 minutes"
  echo "::error::check 'journalctl -u $SERVICE_NAME -n 50' for the failure"
  exit 1
fi

echo
echo "next steps:"
echo "  journalctl -u $SERVICE_NAME -f"
echo "  systemctl restart $SERVICE_NAME                  # after a new image lands"
echo "  systemctl list-timers neary-gtfs-rt-healthcheck # verify hourly probe is scheduled"