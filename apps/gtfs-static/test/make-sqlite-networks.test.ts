import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Regression test for n3ary/app#190 — "Filter by network" chips missing
// after the spec library adoption. The spec library was missing
// networks + route_networks, so the data never landed in the sqlite,
// the app's getNetworks() returned [], and the favorites filter
// section disappeared.
//
// This test builds a minimal GTFS zip (the 5 required spec tables +
// networks.txt + route_networks.txt) and asserts both spec tables
// have rows + the route↔network JOIN the app consumes. The
// producer-computed `network_color` column (and its OKLCh-derived
// values) used to be tested here too, but it moved to the cluj
// adapter as part of n3ary/gtfs#67 — the generic pipeline no longer
// owns per-feed color algebra. See
// `n3ary/gtfs-adapters/adapters/cluj-napoca/src/static/` for the
// equivalent coverage there.

const WORK = join(tmpdir(), `gtfs-static-networks-${Date.now()}`);
const ZIP_PATH = join(WORK, 'feed.gtfs.zip');

function feedZip(): Promise<string> {
  return new Promise((resolve, reject) => {
    mkdirSync(WORK, { recursive: true });
    const out = createWriteStream(ZIP_PATH);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    out.on('close', () => resolve(ZIP_PATH));
    archive.on('error', reject);
    archive.pipe(out);

    // Required spec tables — 2 routes so each can join to a different
    // network. (route_networks.txt's PK is route_id alone, so two
    // rows for the same route_id would collide.)
    archive.append('agency_id,agency_name,agency_url,agency_timezone\nA1,Test Agency,https://example.test,Europe/Bucharest\n', { name: 'agency.txt' });
    archive.append('stop_id,stop_name,stop_lat,stop_lon\nS1,Central,46.0,23.0\n', { name: 'stops.txt' });
    archive.append('route_id,agency_id,route_short_name,route_type\nR1,A1,1,3\nR2,A1,2,3\n', { name: 'routes.txt' });
    archive.append('route_id,service_id,trip_id,direction_id\nR1,WK,R1_0_0,0\nR2,WK,R2_0_0,0\n', { name: 'trips.txt' });
    archive.append('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nR1_0_0,08:00:00,08:00:00,S1,1\nR2_0_0,08:00:00,08:00:00,S1,1\n', { name: 'stop_times.txt' });

    // networks + route_networks — 1:1 by route_id (PK on route_networks).
    archive.append('network_id,network_name\nnight,Night\nschool,School\n', { name: 'networks.txt' });
    archive.append('network_id,route_id\nnight,R1\nschool,R2\n', { name: 'route_networks.txt' });

    archive.finalize();
  });
}

beforeAll(async () => {
  await feedZip();
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('make-sqlite + networks ingestion (n3ary/app#190)', () => {
  it('ingests networks.txt + route_networks.txt into the sqlite blob', async () => {
    const { makeSqlite } = await import('../dist/make-sqlite.js');
    const result = await makeSqlite(ZIP_PATH, 'test-networks');
    expect(result).not.toBeNull();

    // Decompress the .gz so we can open it with better-sqlite3.
    const gz = readFileSync(result!.localPath);
    const raw = gunzipSync(gz);
    const dbPath = join(WORK, 'test-networks.sqlite3');
    writeFileSync(dbPath, raw);

    const db = new Database(dbPath, { readonly: true });
    try {
      // Both public spec tables must have rows.
      const networksCount = (db.prepare('SELECT COUNT(*) AS c FROM networks').get() as { c: number }).c;
      expect(networksCount).toBe(2);

      const rnCount = (db.prepare('SELECT COUNT(*) AS c FROM route_networks').get() as { c: number }).c;
      expect(rnCount).toBe(2);

      // The JOIN consumed by the app: route ↔ network. Each route
      // joins to exactly one network per the public spec. Verifies the
      // route_networks PK constraint (route_id alone) is honored: with
      // a single network per route_id, the join always yields one row.
      const joined = db.prepare(`
        SELECT r.route_short_name, n.network_id
        FROM routes r
        JOIN route_networks rn ON rn.route_id = r.route_id
        JOIN networks n ON n.network_id = rn.network_id
        ORDER BY r.route_short_name
      `).all() as Array<{ route_short_name: string; network_id: string }>;
      expect(joined).toEqual([
        { route_short_name: '1', network_id: 'night' },
        { route_short_name: '2', network_id: 'school' },
      ]);

      // networks.network_color is NOT added by the generic pipeline
      // anymore — the cluj adapter's StaticExtension supplies it via
      // a per-feed hook. Verify the column is absent here.
      const cols = db.prepare("PRAGMA table_info('networks')").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'network_color')).toBe(false);
    } finally {
      db.close();
    }
  }, 30_000);
});