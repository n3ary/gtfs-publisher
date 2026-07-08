# @gtfs/rt -- live RT adapter (Step 7 of n3ary/gtfs-publisher#34)

Fastify-based GTFS-RT adapter. Polls each feed's
`realtime.vehicle_positions` URL (and any `realtime.extra_vehicle_positions[]`
URLs) on a schedule, applies the per-feed adapter's Quirk function, validates
the cleaned `FeedMessage` against `@n3ary/gtfs-spec/schema`, and serves the
canonical protobuf at `GET /rt/<feed_id>/vehicle_positions`.

The Cloudflare edge (Step 10) sits in front of this for cache fan-out.

## Endpoints

| Method | Path                          | Body                       | Notes |
|--------|-------------------------------|----------------------------|-------|
| GET    | `/healthz`                    | `{ status, adapters, feeds }` | Liveness + warm-cache snapshot per source |
| GET    | `/feeds`                      | `{ feeds }`                | Per-feed last-poll info |
| GET    | `/rt/:feed/vehicle_positions` | raw protobuf bytes         | `Content-Type: application/x-protobuf`. Primary source only. |

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

See [`.env.example`](.env.example) for a starter file.

## Per-feed adapters

The proxy is intentionally **feed-agnostic at the source level**: no per-feed
name appears under `src/`. Per-feed logic lives in the adapter package named
by `feed.source.publisher` (already declared in `feeds.json`).

Per-feed adapters are loaded like this:

```
src/adapter.ts:
  if (feed.source.type === 'adapter' && feed.source.publisher) {
    const mod = await import(`${feed.source.publisher}/rt`);
    const quirk = mod.clujQuirk ?? mod.quirk ?? mod.applyTo ?? mod.default;
    return (msg, ctx) => fn.length >= 2 ? fn(msg, ctx) : fn(msg);
  }
  return null; // pass-through
```

The proxy passes `(feedMessage, ctx)` where `ctx = { url, feed: {id, name, country} }`,
so the adapter can:

- See which upstream URL produced the bytes (handles multi-URL flavours
  once `realtime.extra_vehicle_positions[]` is populated)
- Receive per-feed metadata (read-only) for any URL-conditional cleanup

Adding a quirk for a new feed is a one-line change in `feeds/<id>/config.json`
(declaring `source.type: 'adapter'` and `source.publisher`) + the adapter
package itself. **No code change to this proxy.**

Legacy `(msg) => msg` quirks (currently the published
`@n3ary/gtfs-adapter-cluj-napoca@0.3.5`) are wrapped to the 2-arg shape and
the `ctx` parameter is dropped. TEMP: the wrapper goes away once the cluj
adapter publishes the 2-arg signature.

## Per-feed config location

Per-feed author configs (the source-of-truth that the static pipeline copies
into `feeds.json`) live at the repo root:

```
<repo-root>/feeds/<id>/config.json
```

These declare:

- `source.type` + `source.publisher` (adapter name)
- `secrets[]` (env vars the static pipeline injects)
- `license` (attribution text + URL)
- `smoke` (post-fetch contract checks)
- `timing` (bus/travel calibrations)
- `realtime.vehicle_positions` (the primary URL the proxy polls)
- `realtime.extra_vehicle_positions[]` (additional URLs, polled + stored;
  not yet served; reconciliation lands in a follow-up PR)

`gtfs-static` reads these at build time, asks each adapter's `static`
subpath for the parts the adapter owns, and emits `feeds.json` to the
`binaries` branch. The proxy reads only `feeds.json` -- no per-feed
config file.

## Local dev

```bash
pnpm install
pnpm dev   # tsx watch -- reloads on file changes
```

`pnpm dev` needs `FEEDS_JSON` set (e.g. `FEEDS_JSON=./feeds.json pnpm dev`
against a local copy of the registry).

## Test

```bash
pnpm test      # vitest -- server smoke + adapter loader unit
pnpm check     # tsc --noEmit
```

## Deploy

Step 9 of the parent issue -- Containerfile + systemd unit, target
Hetzner CX22. See `config/` for the systemd unit + Containerfile.

## Cross-references

- [n3ary/gtfs-publisher#34](https://github.com/n3ary/gtfs-publisher/issues/34) -- the parent issue (this is Step 7)
- [n3ary/app#161](https://github.com/n3ary/app/issues/161) -- the Cluj quirk rationale
- [gtfs-rt-contract.md](https://github.com/n3ary/app/blob/main/docs/specs/gtfs-rt-contract.md) -- the producer/consumer contract this adapter implements
- [feed-agnostic.md](https://github.com/n3ary/app/blob/main/docs/standards/feed-agnostic.md) -- the per-feed-quirks-belong-upstream rule
