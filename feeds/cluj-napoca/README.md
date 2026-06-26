# cluj-napoca (CTP Cluj enhancement)

Locally-built feed: takes the Transitous-resolved Cluj-Napoca zip as
seed and enhances it with daily-fresh CTP CSV schedules.

> [!NOTE]
> This is the only `source.type === 'build'` feed currently published.
> All other feeds in [`countries.json`](../../countries.json) `include[]`
> are plain Transitous mirrors.

## What this feed does

The pipeline:

1. Downloads `api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip`
   (Transitous serves the mdb-2121 mirror with its spec-compliance
   fixes applied).
2. Hands the seed path to `feeds/cluj-napoca/build.js` via the
   `NEARY_SEED_ZIP` env var.
3. The script:
   - Keeps `agency.txt`, `routes.txt`, `stops.txt`, `shapes.txt`
     from the seed (pass-through, Transitous-validated).
   - **Regenerates** `calendar.txt`, `trips.txt`, `stop_times.txt`
     from daily CTP CSV scrapes
     (`ctpcj.ro/orare/csv/orar_<route>_<svc>.csv`).
   - Adds `feed_info.txt` with `feed_publisher_name="neary-gtfs"`.
   - Re-zips → `$NEARY_OUTPUT_ZIP`.

> [!IMPORTANT]
> Trip IDs follow the canonical CTP format
> `<route_id>_<dir>_<service>_<seq>_<HHMM>` (e.g. `45_1_LV_9_0721`),
> which matches the `cluj-rt-feed.gtfs.ro` GTFS-Realtime feed exactly.
> This is what lets the v2 app JOIN GTFS-RT vehicle positions directly
> to our SQLite blob with no remapping.

## Files

- [`build.js`](build.js) — the enhancement script
- [`config.json`](config.json) — declarative metadata + build knobs
  (CSV URL pattern, service-day IDs, etc.). All registry fields
  (name, country, license SPDX, …) inherited from Transitous.
- [`lib/seed.js`](lib/seed.js) — extracts + parses the seed zip into
  in-memory shapes the build consumes.

## Why local enhancement vs plain mirror?

> [!CAUTION]
> Transitous's Cluj mirror (mdb-2121) is the canonical CTP schedule
> source but its update cadence is irregular — sometimes weeks stale.
> CTP's own CSV timetables at `ctpcj.ro/orare/csv/` are refreshed
> within hours of a schedule change. We scrape those daily to deliver
> the freshest possible schedule to the v2 app.

The eventual upstream PR to Transitous (M4 of the [roadmap](https://github.com/ciotlosm/neary/blob/rebuild/v2-svelte-sqlite/docs/rebuild-v2/neary-gtfs-plan.md#10-evolution-roadmap))
will register our enhanced output as a new source so other Transitous
downstream consumers get the same freshness without needing to run
this script themselves.

## Routes without CSV data

CTP doesn't publish CSVs for every route (currently 4: M26, 2, M35,
39 CREIC). For those, the seed's original schedule is preserved in
the output zip — the route, stops, and shapes survive; only the
schedule is the upstream Transitous version. Build script logs these
explicitly:

```
[cluj-napoca] routes WITHOUT csv (4): M26, 2, M35, 39 CREIC
```
