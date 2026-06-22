# Requirements: neary-gtfs

## Overview

`neary-gtfs` is a multi-agency GTFS static feed generator. It scrapes official transit operator websites (starting with CTP Cluj-Napoca), parses PDF/HTML schedules, and produces a standards-compliant GTFS ZIP per agency. It is consumed by the `neary` app's schedule pipeline (`agencyFeeds.ts` registry) and replaces the stale third-party feed at `external.gtfs.ro`.

**Repo**: `ciotlosm/neary-gtfs`  
**Consumer**: `ciotlosm/neary` (Netlify daily pipeline fetches the published ZIP)

## Architecture principles

1. **One GitHub Action workflow per agency** — each agency's scrape/parse/build/publish runs independently so a failure in one agency doesn't block others.
2. **Static route+stop registry** — a checked-in JSON file per agency maps official route names/stop names to Tranzy API `route_id`/`stop_id`, so the generated GTFS aligns with the live GPS feed.
3. **Format-compatible with `external.gtfs.ro`** — the output ZIP has the same file structure, field names, and conventions so the neary app can swap feeds without pipeline changes.
4. **Idempotent publish** — if the parsed data hasn't changed since the last release, the action succeeds but does NOT publish a new release (no spam).

---

## Requirement 1: Agency registry

**As a** maintainer, **I want** a single source of truth listing each supported agency and its data sources, **so that** adding a new agency is a config-only change.

### Acceptance criteria

1. A `agencies.json` (or per-agency `agencies/<id>/config.json`) contains: Tranzy `agency_id`, agency name, official website URL, schedule page URL pattern, PDF URL pattern, and the GTFS ZIP download URL (the published release asset).
2. The GitHub Action reads this registry to know what to scrape.
3. Adding a new agency requires only a new config entry + its route/stop registry file.

---

## Requirement 2: Route + stop registry (per agency)

**As a** maintainer, **I want** a static mapping from official CTP route names/numbers and stop names to Tranzy `route_id` / `stop_id`, **so that** the generated GTFS matches what the Tranzy live API uses.

### Acceptance criteria

1. File: `agencies/<agency_id>/routes.json` — maps each route (by short name, e.g. "42") to its Tranzy `route_id` (e.g. 40), direction endpoints, and PDF URL.
2. File: `agencies/<agency_id>/stops.json` — maps each stop name (normalized) to its Tranzy `stop_id` and coordinates (lat/lon).
3. The GTFS generator uses these mappings (not guesses) for `route_id`, `stop_id`, `stop_lat`, `stop_lon`.
4. When a new route/stop appears in the CTP data that isn't in the registry, the build logs a warning and skips it (does not crash).

---

## Requirement 3: PDF schedule parser

**As the** pipeline, **I want** to download and parse the official CTP PDF schedules for each route, **so that** I get the authoritative departure times.

### Acceptance criteria

1. For each route in the registry, fetch the PDF from CTP's known URL pattern (`https://www.ctpcj.ro/orare/pdf/orar_<route_short_name>.pdf`).
2. Extract departure times per direction, per service day (LV = weekday, S = Saturday, D = Sunday).
3. Map stop sequences from the PDF to the registered `stop_id`s.
4. Handle CTP's PDF format quirks (merged cells, multi-column layouts, Romanian diacritics).

---

## Requirement 4: GTFS generation (format-compatible)

**As the** neary pipeline, **I want** the output ZIP to have the exact same structure as `external.gtfs.ro/cluj/CLUJ.zip`, **so that** no changes are needed in the neary schedule pipeline.

### Acceptance criteria

1. Output files: `agency.txt`, `routes.txt`, `stops.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt` (and optionally `calendar_dates.txt`, `shapes.txt`).
2. `trip_id` format: `<route_id>_<direction_id>_<service_id>_<sequence>_<HHMM>` — same pattern the neary app's `parseDirection()` and `vehicleMatchingUtils` rely on.
3. `service_id` values: `LV`, `S`, `D`, `LD` — same as the current feed.
4. `calendar.txt` start/end dates cover a reasonable window (e.g. current month start → 6 months out, or match CTP's stated validity).
5. Stop coordinates come from the registry (`stops.json`), not geocoding.

---

## Requirement 5: Change detection + idempotent publish

**As a** maintainer, **I want** the daily action to detect whether the schedule actually changed, **so that** it doesn't spam releases.

### Acceptance criteria

1. After generating the ZIP, compute a content hash (SHA-256 of the sorted, normalized CSV content — not the ZIP itself, since ZIP timestamps differ).
2. Compare with the hash stored in the latest GitHub Release's tag/body/asset metadata.
3. If unchanged: log "no changes detected", exit 0, no new release.
4. If changed: create a new GitHub Release with the ZIP as an asset, tagged `v<date>` (e.g. `v2026-06-22`), body listing which routes changed.

---

## Requirement 6: GitHub Action (per-agency, daily cron)

**As a** maintainer, **I want** a scheduled GitHub Action that runs daily at 00:00 UTC, **so that** the feed stays fresh automatically.

### Acceptance criteria

1. Workflow file: `.github/workflows/build-agency-<id>.yml` (e.g. `build-agency-2.yml` for CTP Cluj).
2. Trigger: `schedule: cron '0 0 * * *'` + `workflow_dispatch` (manual trigger).
3. Steps: checkout → setup Node → install deps → run build script for the agency → compare hash → publish release if changed.
4. The build script is invoked as `node src/build.js --agency 2` (or similar), reading the registry.
5. On failure: the action fails (red) but does NOT delete/corrupt the previous release.

---

## Requirement 7: Existing GTFS validation

**As a** maintainer, **I want** to verify that an agency's existing GTFS (if any) is in the expected format before deciding to regenerate, **so that** we don't overwrite a working feed with a broken one.

### Acceptance criteria

1. If the agency already has a published GTFS ZIP (previous release), download and validate its structure matches requirements (file presence, field names, trip_id format).
2. If it validates: compare schedule content. If same → no-op. If different → regenerate.
3. If it doesn't validate (corrupt/wrong format): regenerate from scratch and publish.

---

## Non-requirements (out of scope for now)

- Real-time GTFS-RT (we use the Tranzy live API for that).
- Shapes generation from GPS traces.
- Multi-city in one ZIP (each agency gets its own ZIP/release).
- Web UI for editing the registry (JSON files + PRs are fine).
