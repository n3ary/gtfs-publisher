# neary-gtfs

GTFS static feed generator for transit agencies. Scrapes official schedule sources (CSV, PDF, or HTML — depending on the agency), builds standards-compliant GTFS ZIPs, and publishes them as GitHub Releases.

**Consumer**: [neary](https://github.com/ciotlosm/neary) — the Netlify schedule pipeline fetches the ZIP URL from this repo's releases.

## Why

Third-party GTFS feeds (like `external.gtfs.ro`) can go stale for months while operators publish updated schedules on their websites. This repo fills the gap by scraping directly from the official source and generating a compatible GTFS ZIP daily.

## Architecture

```
neary-gtfs/
├── agencies/
│   └── 2/                          # Tranzy agency_id = 2 (CTP Cluj)
│       ├── config.json             # Agency metadata + URL patterns
│       ├── routes.json             # route_short_name → Tranzy route_id
│       └── stops.json              # stop_name → Tranzy stop_id + coords
├── src/
│   └── build.js                    # Main build script (per-agency)
├── .github/workflows/
│   └── build-agency-2.yml         # Daily cron for CTP Cluj
└── output/                         # Generated GTFS (gitignored)
```

## Adding a new agency

1. Create `agencies/<tranzy_agency_id>/config.json` with the agency's URL patterns
2. Populate `routes.json` and `stops.json` from the Tranzy API
3. Create `.github/workflows/build-agency-<id>.yml` (copy from agency 2)
4. The build script handles the rest

## How it works

1. **Daily cron** (00:00 UTC) triggers the GitHub Action for each agency
2. **Fetch**: download schedule data from the official source (CTP Cluj uses CSV files)
3. **Parse**: extract departure times, directions, service days
4. **Generate**: produce GTFS files using the route/stop registry for IDs and coordinates
5. **Compare**: compute content hash and compare against the latest GitHub Release
6. **Publish**: if changed, create a new release with the ZIP; if unchanged, exit 0 (no spam)

### Change detection (no-spam publishing)

The pipeline computes a SHA-256 hash of the generated GTFS content (normalized, sorted). This hash is stored in the body of each GitHub Release. On subsequent runs:
- Download the latest release metadata (tag + body)
- Extract the previous hash
- If hashes match → no changes → skip publish (exit 0)
- If hashes differ → publish a new release with the updated ZIP + new hash

No local state, no extra commits — the release itself is the single source of truth.

## GTFS format compatibility

The output is format-compatible with `external.gtfs.ro/cluj/CLUJ.zip`:
- Same `trip_id` pattern: `<route_id>_<direction_id>_<service_id>_<seq>_<HHMM>`
- Same `service_id` values: `LV`, `S`, `D`, `LD`
- Same file set: `agency.txt`, `routes.txt`, `stops.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt`

This means the neary app's `agencyFeeds.ts` just needs its `feedUrl` updated from `external.gtfs.ro` to this repo's release asset URL — no pipeline code changes.

## License

Schedule data © CTP Cluj-Napoca. This tool generates derivative GTFS data for public transit information purposes.
