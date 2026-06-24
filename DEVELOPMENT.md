# Development Guide

## Prerequisites

- Node.js 24+
- A Tranzy API key (set as `TRANZY_API_KEY` environment variable)

## Setup

```bash
npm install
cp .env.example .env   # add your TRANZY_API_KEY
```

## Commands

```bash
# Sync all agencies from Tranzy API (fetches routes, stops, trips, stop_times, shapes)
source .env && npm run sync

# Build offline schedule for CTP Cluj (agency 2)
node src/build.js --agency 2
```

## How it works

### Daily pipeline (GitHub Actions)

1. `npm run sync` — fetches all agencies' static data from Tranzy, writes to `data/`, updates `agencies/<id>/` registry files
2. `node src/build.js --agency 2` — fetches CTP CSV schedules, generates GTFS + compact JSON
3. Hash comparison — only publishes to releases branch if data changed

### Data flow

```
Tranzy API → sync-tranzy.js → data/<id>/*.json (raw) + agencies/<id>/*.json (registry)
CTP CSVs   → build.js       → output/agency-2/ (GTFS + schedule JSON)
Both       → releases branch (served to neary app)
```

### Adding a new agency

1. Get the Tranzy `agency_id` (visible in `data/agency.json` after sync)
2. Create `agencies/<id>/config.json` with the agency's URL patterns
3. Add a build workflow (copy `build-agency-2.yml`)

## CSV schedule source (CTP Cluj)

CTP publishes CSV files at `https://ctpcj.ro/orare/csv/orar_<route>_<service>.csv`

Service IDs: `lv` (weekday), `s` (Saturday), `d` (Sunday)
