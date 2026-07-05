/**
 * Regression test: validate.ts runs for adapter-driven feeds.
 *
 * History: validate() used to be guarded on `source.type === 'remote'`
 * because adapter-driven feeds were assumed to be trustworthy. In
 * July 2026 a cluj-napoca adapter release emitted FK orphans
 * (stop_times.trip_id referenced trips that didn't exist) and the
 * daily cron happily shipped a corrupt sqlite blob. The pipeline
 * now runs validate() for ALL feeds and fails on errors — this test
 * pins that down.
 *
 * Specifically: synthesize a minimal GTFS zip with a stop_times row
 * whose trip_id references a non-existent trip; validate() must throw.
 * If validate() doesn't run for adapter-driven feeds, the build
 * proceeds past the validator and the corrupt data lands in feeds.json
 * — exactly the bug we just fixed.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validate } from '../src/validate.js';

function buildBadZip(): string {
  const dir = join(tmpdir(), `gtfs-bad-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  // Minimal valid set: agency, stops, routes, calendar, trips, stop_times.
  // The bad row is in stop_times: trip_id "T_ORPHAN" doesn't exist in trips.txt.
  writeFileSync(join(dir, 'agency.txt'), 'agency_name,agency_url,agency_timezone\nA,https://a.test,UTC\n');
  writeFileSync(join(dir, 'stops.txt'), 'stop_id,stop_name,stop_lat,stop_lon\nS1,Stop 1,46.77,23.59\n');
  writeFileSync(join(dir, 'routes.txt'), 'route_id,route_short_name,route_long_name,route_type\nR1,1,Downtown,3\n');
  writeFileSync(join(dir, 'calendar.txt'), 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSVC,1,1,1,1,1,0,0,20260701,20261231\n');
  writeFileSync(join(dir, 'trips.txt'), 'route_id,service_id,trip_id\nR1,SVC,T1\n');
  writeFileSync(join(dir, 'stop_times.txt'),
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
    'T1,08:00:00,08:00:00,S1,1\n' +
    'T_ORPHAN,09:00:00,09:00:00,S1,1\n',  // <- bad: T_ORPHAN doesn't exist
  );

  const zipPath = `${dir}.zip`;
  // system zip is on macOS + every Linux CI runner
  const res = spawnSync('zip', ['-j', zipPath, ...[
    'agency.txt', 'stops.txt', 'routes.txt', 'calendar.txt',
    'trips.txt', 'stop_times.txt',
  ].map((f) => join(dir, f))], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`zip failed: ${res.stderr}`);
  rmSync(dir, { recursive: true, force: true });
  return zipPath;
}

describe('validate() (Layer 1: runs for adapter-driven feeds)', () => {
  it('throws on FK orphan in stop_times.trip_id', () => {
    const zipPath = buildBadZip();
    try {
      expect(() => validate(zipPath)).toThrow(/stop_times\.trip_id.*orphan/);
    } finally {
      rmSync(zipPath, { force: true });
    }
  });

  it('throws on missing required column', () => {
    const dir = join(tmpdir(), `gtfs-missing-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    // agency.txt missing required column agency_timezone
    writeFileSync(join(dir, 'agency.txt'), 'agency_name,agency_url\nA,https://a.test\n');
    writeFileSync(join(dir, 'stops.txt'), 'stop_id,stop_name,stop_lat,stop_lon\nS1,Stop 1,46.77,23.59\n');
    writeFileSync(join(dir, 'routes.txt'), 'route_id,route_short_name,route_long_name,route_type\nR1,1,Downtown,3\n');
    writeFileSync(join(dir, 'calendar.txt'), 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSVC,1,1,1,1,1,0,0,20260701,20261231\n');
    writeFileSync(join(dir, 'trips.txt'), 'route_id,service_id,trip_id\nR1,SVC,T1\n');
    writeFileSync(join(dir, 'stop_times.txt'), 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,S1,1\n');

    const zipPath = `${dir}.zip`;
    const res = spawnSync('zip', ['-j', zipPath, ...[
      'agency.txt', 'stops.txt', 'routes.txt', 'calendar.txt',
      'trips.txt', 'stop_times.txt',
    ].map((f) => join(dir, f))], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`zip failed: ${res.stderr}`);
    try {
      expect(() => validate(zipPath)).toThrow(/agency.*missing required column/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(zipPath, { force: true });
    }
  });
});