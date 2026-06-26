# neary-gtfs

Daily pipeline producing GTFS feeds for the [neary](https://github.com/ciotlosm/neary) PWA.

> **Active refactor**: this branch (`refactor/feeds-from-transitous`) is
> migrating to a multi-feed model aligned with
> [public-transport/transitous](https://github.com/public-transport/transitous).
> See [`docs/rebuild-v2/neary-gtfs-plan.md`](https://github.com/ciotlosm/neary/blob/rebuild/v2-svelte-sqlite/docs/rebuild-v2/neary-gtfs-plan.md)
> in the neary repo for the full roadmap (M0 → M5).
>
> Current milestone: **M1 — repo scaffold** (this branch). The
> `releases` branch / v1 app continue working from `main` unchanged.

## What it produces

**M1 (this branch, → `binaries-staging`)**:

| File | Source | Consumer |
|------|--------|----------|
| `outputs/feeds.json` | new pipeline | neary v2 app (single registry) |
| `outputs/feeds/ctp-cluj.gtfs.zip` | CTP CSV scrape (legacy `src/build.js`) | neary v2 app + GTFS validators |

**Legacy (`main` → `releases`, unchanged)**:

| File | Source | Consumer |
|------|--------|----------|
| `data/<id>/*.json` | Tranzy API (`src/sync-tranzy.js`) | neary v1 app |
| `agency-2-schedule.json` | CTP CSV scrape (`src/build.js`) | neary v1 app |
| `agency-2-gtfs.zip` | same | GTFS validators / interop |

## How it works (M1)

`.github/workflows/daily.yml` runs at 00:30 UTC (after Transitous's daily
import) or on manual trigger:

1. **Sync legacy registry** (`npm run sync`) — still needed: the ctp-cluj
   build reads route/stop registry from `agencies/2/*.json`. Replaced in M2.
2. **Pipeline** (`npm run pipeline` = `node src/pipeline/build-all.js`):
   - `resolve-feeds.js` → ctp-cluj only (set `RESOLVE_INCLUDE_TRANSITOUS=true` to test the multi-feed path)
   - `fetch-gtfs.js` → invokes legacy `src/build.js` for ctp-cluj
   - `derive-bbox.js` → reads stops.txt + agency.txt + feed_info.txt from the zip
   - `make-sqlite.js` → no-op stub (M2 wires it up)
   - `make-app-registry.js` → writes `outputs/feeds.json`, schema-validated
3. **GTFS validator** — canonical MobilityData validator, fails build on any ERROR
4. **Publish** — push `outputs/` to `binaries-staging` branch

App consumes from:
```
https://raw.githubusercontent.com/ciotlosm/neary-gtfs/binaries-staging/feeds.json
```
(After M2: `binaries` instead of `binaries-staging`; jsDelivr in front.)

## Structure

```
countries.json                  # ISO codes whose Transitous feeds we mirror
schemas/feeds.schema.json       # JSON Schema for outputs/feeds.json
src/
  build.js                      # legacy CTP build (kept until M2)
  sync-tranzy.js                # legacy Tranzy registry sync (kept until M2)
  pipeline/
    build-all.js                # daily orchestrator
    resolve-feeds.js            # countries.json + Transitous → feed list
    fetch-gtfs.js               # build local or fetch upstream
    derive-bbox.js              # zip → bbox + agencies + validity
    make-sqlite.js              # M2 stub
    make-app-registry.js        # → outputs/feeds.json
    _smoke.js                   # local end-to-end check (no CI)
agencies/2/config.json          # CTP URL patterns (read by src/build.js)
.github/workflows/
  build-agency-2.yml            # legacy: main → releases
  daily.yml                     # M1: refactor → binaries-staging
```

## Local development

See [DEVELOPMENT.md](DEVELOPMENT.md).

## License

Schedule data © CTP Cluj-Napoca. Generated for public transit information
purposes.

