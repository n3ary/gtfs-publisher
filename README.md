# neary-gtfs

GTFS static feed generator for transit agencies. Parses official PDF/HTML schedules and builds standards-compliant GTFS ZIPs, published as GitHub Releases.

**Consumer**: [neary](https://github.com/ciotlosm/neary) — the Netlify schedule pipeline fetches the ZIP URL from this repo's releases.

## Why

The third-party GTFS feed at `external.gtfs.ro` for CTP Cluj is stale (last updated Nov 2025). CTP publishes new schedules on their website but doesn't maintain an up-to-date GTFS feed. This repo fills the gap by scraping the official PDFs and generating a compatible GTFS ZIP.

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
2. **Fetch**: download PDFs for all routes in the agency's `routes.json`
3. **Parse**: extract departure times, directions, service days from PDFs
4. **Generate**: produce GTFS files using the route/stop registry for IDs and coordinates
5. **Compare**: hash the generated content against the latest release
6. **Publish**: if changed, create a new GitHub Release with the ZIP asset

## GTFS format compatibility

The output is format-compatible with `external.gtfs.ro/cluj/CLUJ.zip`:
- Same `trip_id` pattern: `<route_id>_<direction_id>_<service_id>_<seq>_<HHMM>`
- Same `service_id` values: `LV`, `S`, `D`, `LD`
- Same file set: `agency.txt`, `routes.txt`, `stops.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt`

This means the neary app's `agencyFeeds.ts` just needs its `feedUrl` updated from `external.gtfs.ro` to this repo's release asset URL — no pipeline code changes.

## License

Schedule data © CTP Cluj-Napoca. This tool generates derivative GTFS data for public transit information purposes.
