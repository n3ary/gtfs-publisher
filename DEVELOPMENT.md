# Development Guide

## Prerequisites

- Node.js 24+
- `unzip` and `java` on PATH (CI runners have both; macOS/Linux usually do too)
- A Tranzy API key (set as `TRANZY_API_KEY` env var) — only needed for the
  legacy `npm run sync` step, gone in M2

## Setup

```bash
npm install
cp .env.example .env   # add your TRANZY_API_KEY
```

## Commands

```bash
# Legacy path (still produces `releases` branch artifacts on main):
source .env && npm run sync                 # Tranzy → agencies/2/*.json
node src/build.js --agency 2                # → output/agency-2/

# New pipeline (M1, → binaries-staging):
npm run pipeline                            # uses RESOLVE_INCLUDE_TRANSITOUS=false by default
RESOLVE_INCLUDE_TRANSITOUS=true npm run pipeline   # also mirrors Transitous (M2 path)

# Local smoke (doesn't need the legacy build to have run; uses any
# existing zip at outputs/feeds/ctp-cluj.gtfs.zip):
node src/pipeline/_smoke.js
```

## How it works (M1)

### Pipeline orchestrator

```
src/pipeline/build-all.js
  │
  ├─ resolve-feeds.js   ← countries.json + Transitous ro.json
  ├─ for each feed:
  │   ├─ fetch-gtfs.js  ← build local (ctp-cluj) or download (Transitous)
  │   ├─ derive-bbox.js ← unzip -p → stops.txt + agency.txt + feed_info.txt
  │   └─ make-sqlite.js ← stub (M2)
  └─ make-app-registry.js → outputs/feeds.json (schema-validated)
```

### Outputs

```
outputs/
├── feeds.json
└── feeds/
    └── ctp-cluj.gtfs.zip   (+ .sqlite3.gz in M2)
```

### CI

`.github/workflows/daily.yml` runs nightly (00:30 UTC), targeting the
`binaries-staging` branch. The legacy `build-agency-2.yml` keeps running
from `main` → `releases` for the v1 app.

### Adding a new agency (M2+ scope)

1. Add the country's ISO code to `countries.json` (if not already).
2. Verify the country file at
   `https://raw.githubusercontent.com/public-transport/transitous/main/feeds/<iso>.json`
   contains a usable `type: http | transitland-atlas | mobility-database`
   entry.
3. Run `RESOLVE_INCLUDE_TRANSITOUS=true npm run pipeline` locally; check
   `outputs/feeds.json` validates and the per-feed `.gtfs.zip` is sane.
4. Push to `binaries-staging`. Validate end-to-end via the v2 app pointed
   at the staging URL.

## CSV schedule source (CTP Cluj, legacy)

CTP publishes CSV files at `https://ctpcj.ro/orare/csv/orar_<route>_<service>.csv`

Service IDs: `lv` (weekday), `s` (Saturday), `d` (Sunday)

