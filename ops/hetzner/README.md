# `ops/hetzner/` — runtime configs for the GTFS-RT Hetzner VM

Everything in this directory is **deploy-side** — files that get
copied onto the host (or a fresh VM) to run the `gtfs-rt`
container. The repo-stay is purely so the configs are versioned
alongside the artifact they're for; the contents are still
target-specific (currently Hetzner CX23 with systemd + podman).

| File | Purpose | Installed at |
|---|---|---|
| `firewall.json` | Hetzner Cloud Firewall rules — 22+CF-only inbound, 80/443/53/icmp outbound. Created via `hcloud firewall create --name neary-gtfs-rt-01-edge-only --rules-file ops/hetzner/firewall.json` and applied with `hcloud firewall apply-to-resource --type server --server ubuntu-4gb-nbg1-1 neary-gtfs-rt-01-edge-only`. | Hetzner Cloud (network-layer; not on the VM) |
| `dnat-80-to-8080.sh` | iptables DNAT: forwards port 80 → 8080 on the host, so the CF edge can connect to port 80 (its default) while the Fastify origin binds 8080. Idempotent. | `/usr/local/sbin/dnat-80-to-8080.sh` |
| `dnat-80-to-8080.service` | systemd one-shot unit that runs the DNAT script at boot. Persistence so the rule survives reboots. | `/etc/systemd/system/dnat-80-to-8080.service` |

The single bootstrap script (`install.sh`) lives in
[`apps/gtfs-rt/config/install.sh`](../gtfs-rt/config/install.sh) — that's the one the operator runs on the host. It transitively copies `dnat-80-to-8080.sh` and `dnat-80-to-8080.service` from this directory and enables the DNAT systemd unit.

That's the entry point for "rebuild a Hetzner server from
scratch" — `install.sh` is idempotent and meant to be the single
command you run on a fresh VM. The DNAT is a separate unit so it
can be turned on/off without touching the service.

## First-boot order

1. `apt-get update && apt-get -y install git`
2. `git clone https://github.com/n3ary/gtfs-publisher.git && cd gtfs-publisher`
3. (Optional) `export IMAGE=ghcr.io/n3ary/gtfs-rt:sha-<hex>` to pin
4. `bash apps/gtfs-rt/config/install.sh` — installs podman, copies unit + env, copies the DNAT script + unit, enables both, pulls image, starts the service
5. `curl -sSf http://127.0.0.1:8080/healthz` — should return 200 JSON
   (`curl -sSI http://127.0.0.1/healthz` should also work — that's the DNAT'd path)

## Smoke test from the public internet

```bash
curl -sI https://gtfs-rt.n3ary.com/rt/cluj-napoca/vehicle_positions
# expect: HTTP/2 200, content-type: application/x-protobuf,
# cache-control: public, max-age=5, cf-cache-status: MISS (first call) → HIT (within 5s)
```

## Hetzner Cloud Firewall

Created via `hcloud firewall create --name neary-gtfs-rt-01-edge-only --rules-file ops/hetzner/firewall.json` and applied to the VM with `hcloud firewall apply-to-resource`. Inbound:
- tcp/22 from anywhere (SSH; tighten to your IP when you have a
  static one — replace `0.0.0.0/0, ::/0` with your CIDR and rerun
  `hcloud firewall replace-rules --rules-file firewall.json <name>`).
- tcp/80 + tcp/443 from the 15 CF edge IPv4 ranges + 7 IPv6
  ranges (the CF orange-cloud proxy). Other source IPs are
  blocked at the network layer.
- icmp from anywhere (ping).

Outbound: 80/443/53/icmp to anywhere (ghcr.io pull, apt, DNS).
Everything else is blocked.

The firewall sits at the Hetzner edge — it's a *network-layer*
control, in addition to whatever you put on the VM with iptables.
The CF edge always reaches the VM via 178.104.6.65:80 (or :443 if
you set SSL=full_strict on the zone instead of `full`).
