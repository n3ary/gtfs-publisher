# Neary Schedule JSON vs GTFS ZIP

The build produces TWO release assets per agency. They contain the same schedule data in different formats for different consumers.

## `agency-<id>-gtfs.zip` — Standard GTFS

Standard [GTFS static feed](https://gtfs.org/documentation/schedule/reference/) as CSV files in a ZIP:
- `agency.txt`, `routes.txt`, `stops.txt`, `trips.txt`, `stop_times.txt`, `calendar.txt`

**Use case**: Interoperability with any GTFS-consuming tool (Google Maps, Transit app, validators, research).

**Size**: ~8.6 MB (CTP Cluj, 168 routes, 14,652 trips, 202,631 stop_times)

## `agency-<id>-schedule.json` — Neary Compact Format

A deduplicated JSON payload optimized for the [neary](https://github.com/ciotlosm/neary) transit tracking app. The neary client (`scheduleStore.ts`) fetches and expands this directly — no server-side processing needed.

**Use case**: Consumed exclusively by the neary app's client-side `scheduleStore`.

**Size**: ~1.1 MB raw, **~127 KB gzipped** (browser downloads the gzipped version)

### Format

```jsonc
{
  "version": "2026-06-22T06:52:54.372Z",   // ISO timestamp of generation
  "agencyId": 2,                             // Tranzy agency_id
  "patterns": [                              // Unique stop-time sequences (deduplicated)
    [                                        // Each pattern = ordered stops with OFFSET minutes from trip start
      { "s": 208, "q": 0, "a": 0, "d": 0 },       // stop_id, sequence, arrival_offset, departure_offset
      { "s": 18,  "q": 1, "a": 2, "d": 2 },
      { "s": 19,  "q": 2, "a": 4, "d": 4 },
      ...
    ],
    ...
  ],
  "trips": {                                 // Per-trip reference into the patterns table
    "40_0_LV_0_0500": {
      "p": 73,                               // Index into `patterns[]`
      "t": 300,                              // Trip start time (minutes since midnight)
      "s": "LV",                             // service_id
      "r": 40,                               // route_id
      "h": "Biserica Campului"               // trip_headsign
    },
    ...
  },
  "calendar": [                              // Active service patterns
    { "serviceId": "LV", "monday": true, ..., "startDate": "20260601", "endDate": "20261130" },
    ...
  ],
  "calendarExceptions": []                   // Date-specific overrides (if any)
}
```

### Key differences from GTFS

| Aspect | GTFS ZIP | Neary JSON |
|--------|----------|------------|
| Stop times | Absolute (HH:MM:SS per stop per trip) | Offsets from trip start (minutes), shared via pattern dedup |
| Deduplication | None (each trip repeats its full stop sequence) | ~98% dedup — 14,652 trips collapse to ~205 patterns |
| Trip identification | `trip_id` in trips.txt | Same `trip_id` as key in `trips` object |
| Route association | `route_id` in trips.txt | `r` field in each trip ref |
| Service calendar | `calendar.txt` (CSV) | `calendar` array (JSON objects) |
| Coordinates | In `stops.txt` | NOT in this file — the neary app has its own stop store from the Tranzy API |
| File format | CSV files in ZIP | Single JSON file |

### Why the deduplication matters

For CTP Cluj:
- GTFS: 14,652 trips × ~14 stops each = ~202,631 stop_time rows (8.6 MB ZIP)
- Neary JSON: 205 unique patterns + 14,652 trip refs = 1.1 MB raw (127 KB gzipped)

The deduplication works because most trips on the same route follow the exact same stop sequence — only the departure time differs. A pattern stores the stop sequence once (as offsets), and each trip just references its pattern + its start time.

### How the neary client uses it

1. `scheduleStore` fetches `/data/schedule/<id>.json` (proxied via Netlify)
2. `isCompactSchedulePayload()` validates the structure
3. `expandSchedule()` rebuilds the full `SchedulePayload` in memory (absolute times)
4. Schedule features (ghosts, ETAs, departure boards) query the expanded data

The expansion is fast (~10ms) and happens once on load + on midnight crossings.
