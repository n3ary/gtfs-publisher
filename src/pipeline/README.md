# src/pipeline

The SQLite + registry build for the `binaries` branch. See
[../../README.md](../../README.md) for what this repo is and isn't.

## Entry point

```bash
npm run pipeline            # = node src/pipeline/build-all.js
```

## Steps

`build-all.js` walks each feed and runs:

1. **`resolve-feeds.js`** — read [`countries.json`](../../countries.json)
   `include[]` (single source of truth for what we publish). For each
   entry: fetch the matching source from Transitous's `feeds/<iso>.json`.
   If a [`feeds/<id>/config.json`](../../feeds/) declares
   `enhances: "<name>"` matching that Transitous source, apply its
   overrides (source swap, realtime URLs, license, metadata).
2. **HEAD `source.upstream_url`** — compare ETag against the previous
   `feeds.json`. Match → pass the previous entry through unchanged,
   skip everything below.
3. **`fetch-gtfs.js`** — download the zip:
   - `source.type=transitous` → `api.transitous.org/gtfs/<iso>_<name>.gtfs.zip`
   - `source.type=remote`     → `source.upstream_url` from the override
4. **`validate.js`** (`source.type=remote` only) — light Node spec-shape
   check (required files / columns, cross-references, monotonic
   `stop_sequence`). Transitous mirrors are trusted to upstream validation.
5. **`smoke-remote.js`** (`source.type=remote` only) — per-feed contract
   check from the override's `smoke` block (expected
   `feed_publisher_name`, `trip_id` regex). Fails the build on
   contract violation.
6. **`derive-bbox.js`** — `unzip -p` the zip's `stops.txt` /
   `agency.txt` / `feed_info.txt` → bbox, center, agencies, timezone,
   validity dates.
7. **`make-sqlite.js`** — `.zip` → `.sqlite3.gz`. The raw `.gtfs.zip`
   is unlinked after; consumers fetch it from the upstream URL.
8. **`make-app-registry.js`** — write Ajv-validated
   [`outputs/feeds.json`](../../outputs/feeds.json).

Output layout under `outputs/` (mirrors the `binaries` branch root):

```
outputs/feeds.json
outputs/<id>.sqlite3.gz
```

## Skip-on-unchanged

Each `feeds.json` entry records `source.upstream_etag` at build time.
Next run, the orchestrator does a `HEAD` on `source.upstream_url`; if
the ETag matches AND the previous `<id>.sqlite3.gz` is still
referenced, the whole feed is reused from the previous registry — no
download, no make-sqlite, no publish churn.

Previous registry is fetched from
`raw.githubusercontent.com/.../binaries/feeds.json` at the start of
each run (always fresh, not jsDelivr-cached).

## Helpers in `lib/`

- `csv.js` — tiny GTFS-CSV parser (used by `derive-bbox.js` /
  `validate.js` / `smoke-remote.js`)
- `http.js` — shared `User-Agent` constant + `fetchJson` / `fetchText` /
  `fetchToFile`
- `mdb-rt.js` — resolve realtime URLs via the MobilityData catalog
  (one-hop lookup from Transitous's `spec: gtfs-rt` siblings)
