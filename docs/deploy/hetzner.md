# Deploying `@gtfs/rt` to Hetzner

The live GTFS-RT Fastify adapter runs on a single Hetzner CX23 in
`nbg1` (Nuremberg). Cloudflare sits in front as a thin proxy:
orange-clouded `A` record + a 5 s edge-cache rule. No Worker in
the path — the origin serves the public path directly.

This page is the **why** (architecture, failure modes) and the
**how** (operator runbook). The actual configs and bootstrap
script live with the artifact, in
[`apps/gtfs-rt/config/`](../gtfs-rt/config/):

- `neary-gtfs-rt.service` — systemd unit
- `rt.env.example` — env file template
- `install.sh` — one-shot bootstrap (apt install podman, copy
  files, pull image, enable service)

That's the entry point for "rebuild a Hetzner server from
scratch" — the `install.sh` is idempotent and meant to be the
single command you run on a fresh VM.

## Architecture

```
                         CF edge
   ┌────────────────────────────────┐
   │  gtfs-rt.n3ary.com             │  HTTP (port 80 → iptables DNAT → 8080)
   │  • TLS termination             │ ─────────────────────────────┐
   │  • 5 s edge cache (Cache Rule) │                              │
   └────────────────────────────────┘                              ▼
                                                          ┌─────────────────────┐
                                                          │  Hetzner CX23 nbg1  │
                                                          │  systemd + podman   │
                                                          │  + @gtfs/rt image   │
                                                          │  Fastify :8080      │
                                                          └─────────────────────┘
                                                                  ▲
                                                                  │ polled upstreams
                                                                  │ (Tranzy, Transitous…)
```

**Public DNS** — `gtfs-rt.n3ary.com` is the public hostname for
the realtime API (a separate subdomain from `gtfs.n3ary.com`,
which serves the static data on R2). The `A` record points to
the Hetzner VM's public IPv4 and is orange-clouded (proxied). The
origin serves the public path directly: `GET /rt/<feed>/<snake_case>`.
Consumers call the natural snake_case shape; no path rewriting.

**Cache contract** — the CF edge enforces a 5 s edge TTL for
`gtfs-rt.n3ary.com/rt/*` via a Cache Rule (phase
`http_request_cache_settings`). The rule overrides the zone's
default 7200 s edge TTL for the realtime path; the origin's
`Cache-Control: public, max-age=5` is preserved at the browser
TTL. `/healthz` and `/feeds` are excluded from the cache.

**Origin port alignment** — the CF proxy connects to port 80 on
the origin (zone SSL=`full`). The systemd unit binds Fastify to
`8080`. Two clean ways to bridge:
- iptables DNAT on the Hetzner host: `iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8080` (persist via a systemd unit).
- Rebind the Fastify listener to port 80 (needs `AmbientCapabilities=CAP_NET_BIND_SERVICE` on the unit or `setcap` on the node binary in the image).

The VM is intentionally *not* exposed to the public internet beyond
what the CF edge needs. TLS terminates at the edge; the VM serves
plain HTTP, and a firewall block on port 8080 from non-CF source
ranges is a fine hardening step if you want to be paranoid (the CF
edge IPs are documented and stable).

## Why a VM, not serverless?

- **Polling cadence is per-feed, not per-request.** The adapter
  polls each upstream on its own schedule, decodes the protobuf,
  applies the per-feed quirk, and keeps the result in memory. A
  serverless function with a cold start every request would
  re-fetch the upstream on every call.
- **The CF edge in front absorbs the public traffic anyway.** The
  VM only needs to serve the few requests that miss the edge
  cache, plus handle the polling loop. A single small box is
  plenty.
- **Persistent quirks.** The cluj quirk recovers
  `direction_id` + `start_time` from the encoded `trip_id` per
  [n3ary/app#161](https://github.com/n3ary/app/issues/161). When
  upstream-side fixes land
  ([n3ary/gtfs-publisher#36](https://github.com/n3ary/gtfs-publisher/issues/36)),
  the adapter picks them
  up without re-architecting.

## Failure modes and their blast radius

- VM dies → CF edge returns the last cached response for ≤ 5 s
  while the VM reboots. No data loss: the upstream fetches are
  idempotent, and the in-memory store is rebuilt on first poll.
- CF edge cache miss-storm → VM handles the request, returns 200
  with `Cache-Control: public, max-age=5`. VM can do this
  comfortably; a single poll is 15 s × N feeds.
- Upstream RT feed down → `poller.ts` logs the failure and
  retries on the next interval. `/healthz` and `/feeds` show
  the stale `entityCount` and `fetchedAt`. CF keeps serving the
  last cached bytes.

## Initial provision

The Hetzner Cloud API call (run from any machine with `hcloud`
authenticated):

```bash
hcloud server create \
  --name neary-gtfs-rt-01 \
  --type cx23 \
  --location nbg1 \
  --image ubuntu-24.04 \
  --ssh-key <your-key-name> \
  --start-after-create
```

> **Note:** The issue called for "Hetzner CX22" but the
> cost-optimized line was renamed to CX23 in 2025. Same shape,
> same price tier, same architecture.

The CX23 specs: 2 vCPU (shared AMD EPYC), 4 GB RAM, 40 GB SSD,
20 TB outbound / month, €5.49 / month net.

## Cross-references

- [`apps/gtfs-rt/config/`](../gtfs-rt/config/) — systemd unit,
  env file template, install script
- [`apps/gtfs-rt/Containerfile`](../gtfs-rt/Containerfile) —
  container build
- [n3ary/gtfs-publisher#74](https://github.com/n3ary/gtfs-publisher/issues/74) —
  parent issue
- [n3ary/gtfs-publisher#34](https://github.com/n3ary/gtfs-publisher/issues/34) —
  the original monorepo migration umbrella
- [n3ary/gtfs-publisher#36](https://github.com/n3ary/gtfs-publisher/issues/36) —
  the parser-half follow-up (depends on this deploy for live
  data to validate against)
