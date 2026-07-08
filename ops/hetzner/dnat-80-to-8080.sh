#!/usr/bin/env bash
#
# dnat-80-to-8080.sh — iptables DNAT for the GTFS-RT origin.
#
# Cloudflare's orange-cloud proxy connects to origin port 80 by
# default (zone SSL=full → CF terminates TLS, speaks plain HTTP to
# the origin on port 80). The neary-gtfs-rt systemd unit binds
# Fastify to 8080, so we DNAT 80 → 8080 on the host.
#
# Idempotent: re-runs are safe. The matching rule is detected and
# skipped if it's already in place.
#
# Persistence: this script is run once at boot by
# /etc/systemd/system/dnat-80-to-8080.service (see ops/hetzner/).

set -euo pipefail

CHAIN="NEARY_RT_DNAT"
TABLE="nat"
PREROUTING_RULE=(
  -t "$TABLE"
  -A PREROUTING
  -p tcp
  --dport 80
  -j REDIRECT
  --to-port 8080
)
OUTPUT_RULE=(
  -t "$TABLE"
  -A OUTPUT
  -p tcp
  --dport 80
  -j REDIRECT
  --to-port 8080
)

if ! iptables -t "$TABLE" -L "$CHAIN" -n >/dev/null 2>&1; then
  echo "[dnat] creating chain $CHAIN in table $TABLE"
  iptables -t "$TABLE" -N "$CHAIN"
  # Send 80/tcp traffic from non-local sources to the chain
  iptables -t "$TABLE" -A PREROUTING -p tcp --dport 80 -j "$CHAIN"
  # Same for traffic from the host itself (e.g. curl localhost
  # bypasses the PREROUTING hook on the loopback path, but OUTPUT
  # catches it).
  iptables -t "$TABLE" -A OUTPUT -p tcp --dport 80 -j "$CHAIN"
fi

# Add the DNAT itself if missing.
if ! iptables -t "$TABLE" -C "$CHAIN" "${PREROUTING_RULE[@]:1}" 2>/dev/null; then
  echo "[dnat] adding PREROUTING DNAT: tcp/80 → tcp/8080"
  iptables -t "$TABLE" -A "$CHAIN" "${PREROUTING_RULE[@]:1}"
fi

# Also do the OUTPUT-side DNAT for local-host calls. Same rule
# shape but in the OUTPUT chain so curl http://127.0.0.1/ works.
if ! iptables -t "$TABLE" -C OUTPUT "${OUTPUT_RULE[@]:1}" 2>/dev/null; then
  echo "[dnat] adding OUTPUT DNAT: tcp/80 → tcp/8080 (loopback)"
  iptables -t "$TABLE" -A OUTPUT "${OUTPUT_RULE[@]:1}"
fi

echo "[dnat] current rules for $CHAIN:"
iptables -t "$TABLE" -L "$CHAIN" -n -v
