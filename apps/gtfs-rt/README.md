# @gtfs/rt — live RT adapter (Step 7 of n3ary/gtfs-publisher#34)

Fastify-based GTFS-RT adapter. Polls each feed's `realtime.vehicle_positions`
URL on a schedule, applies per-feed quirks, and serves a clean
`FeedMessage` (protobuf) at `GET /rt/<feed_id>/vehicle_positions`.

The Cloudflare edge (Step 10) sits in front of this for cache fan-out.

## Endpoints

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/healthz` | `{ status, feeds, quirks }` | Liveness + warm-cache snapshot |
| GET | `/feeds` | `{ feeds }` | Per-feed last-poll info |
| GET | `/rt/:feed/vehicle_positions` | raw protobuf bytes | `Content-Type: application/x-protobuf` |

## Env vars

| Var | Default | Notes |
|---|---|---|
| `FEEDS_JSON` | (required) | URL or path of `feeds.json` (e.g. `https://gtfs.n3ary.com/feeds.json`) |
| `PORT` | `8080` | TCP port the Fastify server binds |
| `HOST` | `0.0.0.0` | Listen address |
| `POLL_INTERVAL_MS` | `15000` | Per-feed poll interval (ms) |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Per-fetch timeout (ms) |
| `LOG_LEVEL` | `info` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `ENABLED_FEEDS` | (empty = all) | Comma-separated feed IDs to enable |

See [.env.example](.env.example) for a starter file.

## Quirks

The proxy is intentionally feed-agnostic at the source level: no
per-feed name appears in `src/`. Per-feed quirks live in
`@n3ary/gtfs-adapter-<id>` packages and are wired in via a small
config file under `feeds/<feedId>/config.json`:

```json
{ "adapter": "@n3ary/gtfs-adapter-cluj-napoca" }
```

At startup (and lazily on first poll tick) the loader reads
`<configDir>/<feedId>/config.json` and dynamic-imports
`<adapter>/rt`. The adapter's exports are inspected for a
`Quirk`-shaped function (`clujQuirk` / `quirk` / `applyTo` /
`default`) and the resulting function is wired into the
fetch -> decode -> quirk -> re-encode pipeline.

Adding a quirk for a new feed is exactly two files: the adapter
package (separate repo, `@n3ary/gtfs-adapter-<id>`) and a
`feeds/<id>/config.json` pointing at it. No code change to the
proxy itself.

Feeds with no `config.json` are served as-is from upstream
(pass-through).

## Local dev

```bash
pnpm install
pnpm dev   # tsx watch — reloads on file changes
```

`pnpm dev` needs `FEEDS_JSON` set (e.g. `FEEDS_JSON=./feeds.json pnpm dev`
against a local copy of the registry).

## Test

```bash
pnpm test      # vitest -- server smoke + quirk loader unit
pnpm check     # tsc --noEmit
```

## Deploy

Step 9 of the parent issue — Dockerfile + systemd unit, target
Hetzner CX22. Not in this package yet.

## Cross-references

- [n3ary/gtfs-publisher#34](https://github.com/n3ary/gtfs-publisher/issues/34) — the parent issue (this is Step 7)
- [n3ary/app#161](https://github.com/n3ary/app/issues/161) — the Cluj quirk rationale
- [gtfs-rt-contract.md](https://github.com/n3ary/app/blob/main/docs/specs/gtfs-rt-contract.md) — the producer/consumer contract this adapter implements
- [feed-agnostic.md](https://github.com/n3ary/app/blob/main/docs/standards/feed-agnostic.md) — the per-feed-quirks-belong-upstream rule
