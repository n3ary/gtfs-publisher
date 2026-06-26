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
   declares `enhances: "<name>"` matching that Transitous source,
   promote it to an enhanced build; otherwise plain mirror.
2. **For each feed**:
   - **`fetch-gtfs.js`**:
     - Plain mirror → download `api.transitous.org/gtfs/<iso>_<name>.gtfs.zip`
       (skipped entirely if upstream `ETag` matches previous run)
     - Enhanced build → download the same Transitous zip as seed,
       hand its path to `feeds/<id>/build.js` via `NEARY_SEED_ZIP`;
       the script mutates the zip and writes the final
       `outputs/feeds/<id>.gtfs.zip`
   - **`validate.js`** (`source.type === 'build'` only) — light Node
     spec-shape check (required files / columns, cross-references,
     stop_sequence monotonicity). Transitous mirrors are trusted to
     upstream validation.
   - **`derive-bbox.js`** — `unzip -p` the zip's `stops.txt` /
     `agency.txt` / `feed_info.txt` → bbox, agencies, timezone,
     validity dates.
   - **`make-sqlite.js`** — `.zip` → `.sqlite3.gz`. Skipped for
     enhanced builds when the new zip's stable content-hash matches
     the previous run.
3. **`make-app-registry.js`** — write `outputs/feeds.json`
   (Ajv-validated against [`schemas/feeds.schema.json`](../../schemas/feeds.schema.json)).

## Skip-on-unchanged

Each `source` entry in `feeds.json` records a change-detection token:

| Source type | Token | Captured by | Compared by |
|---|---|---|---|
| `transitous` | `source.upstream_etag` | HTTP `HEAD` on upstream | HEAD-only fast path; skips download + everything if matched |
| `build` | `source.content_hash` | [`lib/zip-hash.js`](lib/zip-hash.js): SHA-256 of sorted entry-name + content | Computed after build script runs; skips make-sqlite + publish if matched |

Previous registry is fetched from `raw.githubusercontent.com/.../binaries/feeds.json`
at the start of each run (always fresh, not jsDelivr-cached).

## Shared helpers in `lib/`

- `csv.js` — tiny GTFS-CSV parser (shared with `derive-bbox.js` and the
  feed seed loaders)
- `http.js` — shared `User-Agent` constant + `fetchJson` / `fetchText` /
  `fetchToFile`
- `mdb-rt.js` — resolve realtime URLs via the MobilityData catalog
  (one-hop lookup from Transitous's `spec: gtfs-rt` siblings)
- `zip-hash.js` — stable content hash of a zip (sorted entry-name +
  entry-content), used for the build-side skip-on-unchanged
