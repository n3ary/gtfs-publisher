# Requirements: neary-gtfs

## Overview

Daily pipeline that:
1. Syncs static transit data (routes, stops, trips, stop_times, shapes) from the Tranzy API for all agencies
2. Builds offline schedule data from CTP Cluj CSV timetables
3. Publishes to the `releases` branch, served directly to the neary PWA via `raw.githubusercontent.com`

**Repo**: `ciotlosm/neary-gtfs`
**Consumer**: `ciotlosm/neary` (fetches static data + schedule JSON directly from GitHub raw, CORS-open)

## Architecture

- Single GitHub Action workflow handles both sync and build
- Hash-based change detection — only publishes when data differs
- Two data paths: Tranzy API (static transit data) and CTP CSV (schedule)
- Output served from orphan `releases` branch (no build artifacts in main)

---

## Requirement 1: Tranzy API sync

**As the** pipeline, **I want** to fetch all agencies' static data from Tranzy daily, **so that** the neary app has fresh routes/stops/shapes without needing user API keys.

### Implementation

- `src/sync-tranzy.js` fetches `/agency`, then for each: `/routes`, `/stops`, `/trips`, `/stop_times`, `/shapes`
- SHA-256 hash per endpoint — only writes files when content changes
- Outputs raw JSON to `data/<agency_id>/<endpoint>.json`
- Also writes registry files (`agencies/<id>/*.json`) for the build script
- Writes `data/hashes.json` manifest with `syncedAt` timestamp

---

## Requirement 2: CTP Cluj schedule build (agency 2)

**As the** pipeline, **I want** to scrape CTP's CSV timetables and generate a compact schedule payload, **so that** the neary app can show offline departures.

### Implementation

- `src/build.js --agency 2` fetches CSV files from `ctpcj.ro/orare/csv/`
- Service days: `lv` (weekday), `s` (Saturday), `d` (Sunday)
- Generates standard GTFS files + compact `agency-2-schedule.json`
- Uses registry files from the sync step for route/stop ID mapping

---

## Requirement 3: Change detection

**As a** maintainer, **I want** to avoid publishing unchanged data, **so that** the releases branch stays clean and GitHub caches remain valid.

### Implementation

- Static data: SHA-256 hashes in `data/hashes.json`, compared between runs
- Schedule: content hash stored in GitHub Release body, compared via `gh release view`
- Publish step only runs when `static_changed == true` or `schedule_changed == true`
- Git commit to releases branch only when `git diff --cached` shows changes

---

## Requirement 4: Publishing

**As the** neary app, **I want** static data at stable URLs on the releases branch, **so that** I can fetch without authentication.

### Implementation

- Releases branch structure: `data/<id>/<endpoint>.json`, `data/hashes.json`, `agency-2-schedule.json`
- URLs: `https://raw.githubusercontent.com/ciotlosm/neary-gtfs/releases/data/...`
- CORS: GitHub raw returns `access-control-allow-origin: *`
- Schedule also published as GitHub Release asset (for GTFS tool interop)

---

## Requirement 5: Agency configuration

**As a** maintainer, **I want** to add agencies with minimal config, **so that** scaling to more cities is easy.

### Implementation

- `agencies/<id>/config.json` — agency-specific settings (CSV URL patterns, service day mappings)
- Tranzy data auto-discovered via `/agency` endpoint (no manual config needed for sync)
- Only agencies with a `config.json` get the offline schedule build; others get static data only

---

## Non-requirements

- Real-time GTFS-RT (neary uses Tranzy `/vehicles` API directly)
- PDF parsing (CTP provides CSV; PDF URL in config is unused)
- Multiple build workflows (single workflow handles sync + build)
- Netlify involvement (neary fetches from GitHub raw, not Netlify proxy)
