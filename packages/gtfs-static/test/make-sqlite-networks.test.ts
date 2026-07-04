import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Regression test for n3ary/app#190 — "Filter by network" chips missing
// after the spec library adoption. The spec refactor moved networks /
// route_networks out of the producer's local SCHEMA into EXTENSIONS,
// but the make-sqlite ingestion loop never got updated to iterate
// EXTENSIONS too. Result: networks.txt rows never landed in the
// sqlite, the app's getNetworks() returned [], and the favorites
// filter section disappeared.
//
// This test builds a minimal GTFS zip (the 5 required spec tables +
// networks.txt + route_networks.txt) and asserts that both extension
// tables have rows + a network_color was computed and persisted.

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

    // Required spec tables — minimal 1-stop, 1-route, 1-trip fixture.
    archive.append('agency_id,agency_name,agency_url,agency_timezone\nA1,Test Agency,https://example.test,Europe/Bucharest\n', { name: 'agency.txt' });
    archive.append('stop_id,stop_name,stop_lat,stop_lon\nS1,Central,46.0,23.0\n', { name: 'stops.txt' });
    archive.append('route_id,agency_id,route_short_name,route_type\nR1,A1,1,3\n', { name: 'routes.txt' });
    archive.append('route_id,service_id,trip_id,direction_id\nR1,WK,R1_0_0,0\n', { name: 'trips.txt' });
    archive.append('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nR1_0_0,08:00:00,08:00:00,S1,1\n', { name: 'stop_times.txt' });

    // Extension tables — two networks, two route_networks rows.
    archive.append('network_id,network_name\nnight,Night\nschool,School\n', { name: 'networks.txt' });
    archive.append('network_id,route_id\nnight,R1\nschool,R1\n', { name: 'route_networks.txt' });

    archive.finalize();
  });
}

beforeAll(async () => {
  await feedZip();
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('make-sqlite + EXTENSIONS ingestion (n3ary/app#190)', () => {
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
      // Both extension tables must have rows.
      const networksCount = (db.prepare('SELECT COUNT(*) AS c FROM networks').get() as { c: number }).c;
      expect(networksCount).toBe(2);

      const rnCount = (db.prepare('SELECT COUNT(*) AS c FROM route_networks').get() as { c: number }).c;
      expect(rnCount).toBe(2);

      // network_color is pre-computed by the pipeline (see route-colors.ts).
      // It must NOT be null — the app reads it verbatim for the chip color.
      const colors = db.prepare('SELECT network_id, network_color FROM networks ORDER BY network_id').all() as Array<{ network_id: string; network_color: string | null }>;
      expect(colors).toEqual([
        { network_id: 'night', network_color: expect.stringMatching(/^[0-9A-F]{6}$/) },
        { network_id: 'school', network_color: expect.stringMatching(/^[0-9A-F]{6}$/) },
      ]);

      // The JOIN consumed by the app: route ↔ network. Sanity-check it.
      const joined = db.prepare(`
        SELECT r.route_short_name, n.network_id
        FROM routes r
        JOIN route_networks rn ON rn.route_id = r.route_id
        JOIN networks n ON n.network_id = rn.network_id
        ORDER BY n.network_id
      `).all() as Array<{ route_short_name: string; network_id: string }>;
      expect(joined).toEqual([
        { route_short_name: '1', network_id: 'night' },
        { route_short_name: '1', network_id: 'school' },
      ]);
    } finally {
      db.close();
    }
  }, 30_000);
});