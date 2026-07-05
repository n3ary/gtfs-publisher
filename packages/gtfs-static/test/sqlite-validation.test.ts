/**
 * Layer 2 end-to-end: a malformed GTFS zip should fail loudly at
 * SQLite load time, not silently ship corrupt data.
 *
 * History: before this guard, a cluj-napoca adapter release emitted
 * FK orphans in stop_times.txt and the daily cron happily shipped
 * a corrupt sqlite blob. Now make-sqlite.ts enables PRAGMA
 * foreign_keys = ON, and the spec DDL declares CHECK + FK constraints
 * — so a malformed row fails at INSERT with a clear SQLite error
 * naming the violated constraint.
 *
 * This test synthesizes a zip with a single bad row and verifies
 * that make-sqlite propagates the error instead of swallowing it.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeSqlite } from '../src/make-sqlite.js';

function buildZip(filenameToBody: Record<string, string>): string {
  const dir = join(tmpdir(), `gtfs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const filePaths: string[] = [];
  for (const [filename, body] of Object.entries(filenameToBody)) {
    const p = join(dir, filename);
    writeFileSync(p, body);
    filePaths.push(p);
  }
  const zipPath = `${dir}.zip`;
  const res = spawnSync('zip', ['-j', zipPath, ...filePaths], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`zip failed: ${res.stderr}`);
  rmSync(dir, { recursive: true, force: true });
  return zipPath;
}

const VALID_AGENCY = 'agency_name,agency_url,agency_timezone\nA,https://a.test,UTC\n';
const VALID_STOPS = 'stop_id,stop_name,stop_lat,stop_lon\nS1,Stop 1,46.77,23.59\n';
const VALID_ROUTES = 'route_id,route_short_name,route_long_name,route_type\nR1,1,Downtown,3\n';
const VALID_CALENDAR = 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSVC,1,1,1,1,1,0,0,20260701,20261231\n';
const VALID_TRIPS = 'route_id,service_id,trip_id\nR1,SVC,T1\n';
const VALID_STOP_TIMES = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,S1,1\n';

describe('makeSqlite (Layer 2: hard fail on bad GTFS)', () => {
  it('loads a valid zip end-to-end', async () => {
    const zip = buildZip({
      'agency.txt': VALID_AGENCY,
      'stops.txt': VALID_STOPS,
      'routes.txt': VALID_ROUTES,
      'calendar.txt': VALID_CALENDAR,
      'trips.txt': VALID_TRIPS,
      'stop_times.txt': VALID_STOP_TIMES,
    });
    try {
      const result = await makeSqlite(zip, 'test-feed');
      // makeSqlite returns a SqliteFile { localPath, sizeBytes, hash }
      // or null if the zip had no usable data.
      expect(result).not.toBeNull();
      expect(result!.localPath).toMatch(/\.sqlite3(\.gz)?$/);
      const stats = readFileSync(result!.localPath);
      expect(stats.length).toBeGreaterThan(0);
    } finally {
      rmSync(zip, { force: true });
    }
  });

  it('rejects stop with out-of-range lat (CHECK constraint)', async () => {
    const zip = buildZip({
      'agency.txt': VALID_AGENCY,
      // stop_lat = 200.0 is outside [-90, 90].
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nS1,Stop 1,200.0,23.59\n',
      'routes.txt': VALID_ROUTES,
      'calendar.txt': VALID_CALENDAR,
      'trips.txt': VALID_TRIPS,
      'stop_times.txt': VALID_STOP_TIMES,
    });
    try {
      await expect(makeSqlite(zip, 'test-feed')).rejects.toThrow(/CHECK constraint failed: stop_lat/);
    } finally {
      rmSync(zip, { force: true });
    }
  });

  it('rejects stop_times with FK orphan trip_id', async () => {
    const zip = buildZip({
      'agency.txt': VALID_AGENCY,
      'stops.txt': VALID_STOPS,
      'routes.txt': VALID_ROUTES,
      'calendar.txt': VALID_CALENDAR,
      'trips.txt': VALID_TRIPS,
      // trip_id "T_ORPHAN" doesn't exist in trips.txt.
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT_ORPHAN,08:00:00,08:00:00,S1,1\n',
    });
    try {
      await expect(makeSqlite(zip, 'test-feed')).rejects.toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      rmSync(zip, { force: true });
    }
  });

  it('rejects stop_times with arrival_time > departure_time', async () => {
    const zip = buildZip({
      'agency.txt': VALID_AGENCY,
      'stops.txt': VALID_STOPS,
      'routes.txt': VALID_ROUTES,
      'calendar.txt': VALID_CALENDAR,
      'trips.txt': VALID_TRIPS,
      // arrival > departure is a contract violation.
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,09:00:00,08:00:00,S1,1\n',
    });
    try {
      await expect(makeSqlite(zip, 'test-feed')).rejects.toThrow(/CHECK constraint failed: arrival_time/);
    } finally {
      rmSync(zip, { force: true });
    }
  });

  it('rejects route with route_color of wrong length', async () => {
    const zip = buildZip({
      'agency.txt': VALID_AGENCY,
      'stops.txt': VALID_STOPS,
      // route_color must be exactly 6 hex chars (no #).
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type,route_color\nR1,1,Downtown,3,FFF\n',
      'calendar.txt': VALID_CALENDAR,
      'trips.txt': VALID_TRIPS,
      'stop_times.txt': VALID_STOP_TIMES,
    });
    try {
      await expect(makeSqlite(zip, 'test-feed')).rejects.toThrow(/CHECK constraint failed: route_color/);
    } finally {
      rmSync(zip, { force: true });
    }
  });

  it('rejects calendar with start_date > end_date', async () => {
    const zip = buildZip({
      'agency.txt': VALID_AGENCY,
      'stops.txt': VALID_STOPS,
      'routes.txt': VALID_ROUTES,
      'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSVC,1,1,1,1,1,0,0,20261231,20260701\n',
      'trips.txt': VALID_TRIPS,
      'stop_times.txt': VALID_STOP_TIMES,
    });
    try {
      await expect(makeSqlite(zip, 'test-feed')).rejects.toThrow(/CHECK constraint failed: start_date/);
    } finally {
      rmSync(zip, { force: true });
    }
  });
});