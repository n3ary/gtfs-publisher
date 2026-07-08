/**
 * dry-run-fixture.ts — synthetic GTFS zip for SKIP_ADAPTER_DRY_RUN=1.
 *
 * When `SKIP_ADAPTER_DRY_RUN=1` is set (PR-validation on forks
 * without the feed's declared secrets, local sanity runs without
 * network), the per-feed adapter call is short-circuited and this
 * module provides a tiny valid GTFS zip in its place. The rest of
 * the pipeline (deriveBbox, makeSqlite, makeAppRegistry, daily.yml's
 * prune list) then exercises end-to-end with **zero external HTTP** —
 * true dry mode, not fail-open.
 *
 * The fixture is the minimum GTFS Schedule dataset the spec requires:
 *   agency.txt, stops.txt, routes.txt, trips.txt, stop_times.txt,
 *   calendar.txt. Two routes + two stops so bbox + route_networks JOIN
 *   tests have a real shape to assert against. Valid for a 30-day
 *   window centered on `buildDate` (default = today).
 *
 * IMPORTANT: this is NOT a substitute for `validate.ts`'s spec-shape
 * smoke check — those guards still run on real builds and skip the
 * dry-run path entirely (validate.ts runs only on `feed.source.type
 * === 'remote'`, see cli.ts).
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
// archiver's ESM namespace exposes `ZipArchive` (a class), not a
// callable factory. Use the named class import — same pattern as
// `test/make-sqlite-networks.test.ts` and `test/extension-api.test.ts`.
import { ZipArchive } from 'archiver';

/**
 * Generate a minimal valid GTFS zip at `outputPath` and return the
 * resolved absolute path. Caller is responsible for hashing it + adding
 * it to the content-addressed filename pool (same as `fetchGtfs`).
 *
 * `feedId` is only used for log output — the zip content is generic.
 */
export function buildDryRunGtfsZip(outputDir: string, feedId: string, buildDate: Date = new Date()): Promise<string> {
  mkdirSync(outputDir, { recursive: true });
  const zipPath = join(outputDir, `${feedId}-dryrun.gtfs.zip`);

  const startDate = formatGtfsDate(addDays(buildDate, -15));
  const endDate = formatGtfsDate(addDays(buildDate, 15));

  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    out.on('close', () => {
      console.log(`[dry-run] wrote ${zipPath} (${archive.pointer()} bytes) — synthetic GTFS for ${feedId}`);
      resolve(zipPath);
    });
    archive.on('warning', (err: unknown) => console.warn(`[dry-run] ${feedId}: ${(err as Error).message ?? String(err)}`));
    archive.on('error', reject);
    archive.pipe(out);

    // agency.txt — single agency, UTC timezone so the fixture has no
    // feed-specific time-zone assumptions.
    archive.append(
      'agency_id,agency_name,agency_url,agency_timezone\n' +
      'A1,Dry-Run Transit,https://example.test/dry-run,UTC\n',
      { name: 'agency.txt' },
    );

    // stops.txt — 2 stops so bbox has a real span. Coordinates are
    // intentionally non-zero but otherwise arbitrary — the fixture
    // exists to exercise pipeline shape, not to be a real feed.
    archive.append(
      'stop_id,stop_name,stop_lat,stop_lon\n' +
      'S1,Stop-A,1.0000,1.0000\n' +
      'S2,Stop-B,1.0100,1.0100\n',
      { name: 'stops.txt' },
    );

    // routes.txt — 2 routes so the schema's `routes` table is non-empty.
    archive.append(
      'route_id,agency_id,route_short_name,route_long_name,route_type\n' +
      'R1,A1,1,Central-North,3\n' +
      'R2,A1,2,North-Central,3\n',
      { name: 'routes.txt' },
    );

    // calendar.txt — single service_id WK, valid across the dry-run window.
    archive.append(
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
      `WK,1,1,1,1,1,1,1,${startDate},${endDate}\n`,
      { name: 'calendar.txt' },
    );

    // trips.txt — one trip per route, direction 0.
    archive.append(
      'route_id,service_id,trip_id,direction_id\n' +
      'R1,WK,R1_0_DRY,0\n' +
      'R2,WK,R2_0_DRY,0\n',
      { name: 'trips.txt' },
    );

    // stop_times.txt — both stops, increasing stop_sequence, 1-min headway.
    archive.append(
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
      'R1_0_DRY,08:00:00,08:00:00,S1,1\n' +
      'R1_0_DRY,08:01:00,08:01:00,S2,2\n' +
      'R2_0_DRY,08:00:00,08:00:00,S1,1\n' +
      'R2_0_DRY,08:01:00,08:01:00,S2,2\n',
      { name: 'stop_times.txt' },
    );

    archive.finalize();
  });
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

function formatGtfsDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}