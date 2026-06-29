# src/pipeline

Daily build orchestrator and its helpers. See main
[README.md](../../README.md#how-it-layers) for the higher-level data flow.

## Entry point

```bash
npm run pipeline            # = node src/pipeline/build-all.js
```

## Steps

1. **`resolve-feeds.js`** — read [`countries.json`](../../countries.json)'s
   `include[]` (single source of truth for what we publish). For each
   entry: fetch the matching source from Transitous's
   `feeds/<iso>.json`. If a [`feeds/<id>/config.json`](../../feeds/)
   declares `enhances: "<name>"` matching that Transitous source, apply
   its overrides (source swap, realtime URLs, metadata).
2. **For each feed**:
   - **`fetch-gtfs.js`**:
     - Plain mirror (`source.type=transitous`) → download
       `api.transitous.org/gtfs/<iso>_<name>.gtfs.zip`
     - Sister-repo (`source.type=remote`) → download the URL declared
       in the override's `source.url`
     - Skipped entirely if upstream `ETag` matches previous run
   - **`validate.js`** (`source.type=remote` only) — light Node
     spec-shape check (required files / columns, cross-references,
     stop_sequence monotonicity). Transitous mirrors are trusted to
     upstream validation.
   - **`smoke-remote.js`** (`source.type=remote` only) — per-feed
     contract check from the override's `smoke` block
     (expected `feed_publisher_name`, `trip_id` pattern).
   - **`derive-bbox.js`** — `unzip -p` the zip's `stops.txt` /
     `agency.txt` / `feed_info.txt` → bbox, agencies, timezone,
     validity dates.
   - **`make-sqlite.js`** — `.zip` → `.sqlite3.gz`. The `.gtfs.zip` is
     unlinked after — consumers fetch the raw zip from the upstream URL.
3. **`make-app-registry.js`** — write `outputs/feeds.json`
   (Ajv-validated against [`schemas/feeds.schema.json`](../../schemas/feeds.schema.json)).

Published layout (binaries branch root):

```
feeds.json
<id>.sqlite3.gz   ← one per feed in feeds.json
```

## Skip-on-unchanged

Each `source` entry in `feeds.json` records the upstream ETag at build
time. Next run, `build-all.js` does a `HEAD` on `source.upstream_url`; if
the ETag matches AND the previous `<id>.sqlite3.gz` is still referenced,
the entire feed is reused from the previous registry — no download, no
make-sqlite, no publish churn.

Previous registry is fetched from `raw.githubusercontent.com/.../binaries/feeds.json`
at the start of each run (always fresh, not jsDelivr-cached).

## Shared helpers in `lib/`

- `csv.js` — tiny GTFS-CSV parser (shared with `derive-bbox.js` /
  `validate.js` / `smoke-remote.js`)
- `http.js` — shared `User-Agent` constant + `fetchJson` / `fetchText` /
  `fetchToFile`
- `mdb-rt.js` — resolve realtime URLs via the MobilityData catalog
  (one-hop lookup from Transitous's `spec: gtfs-rt` siblings)
