import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Regression test for the makeSqlite StaticExtension API contract
// (n3ary/gtfs#X — feeding per-feed additions into the generic static
// pipeline without in-tree per-feed knowledge).
//
// Builds a minimal GTFS zip (5 required spec tables) and invokes
// makeSqlite() with a fully caller-supplied extension:
//   - columnExtensions: ALTER TABLE routes ADD COLUMN route_extra TEXT
//   - tableExtensions : CREATE TABLE _demo (k PRIMARY KEY, v) + 2 rows
//   - fillComputedColumns: writes networks.network_extra = '#demo'

const WORK = join(tmpdir(), `gtfs-static-extension-${Date.now()}`);
const ZIP_PATH = join(WORK, 'feed.gtfs.zip');
const OUT_DIR = join(WORK, 'outputs');

function feedZip(): Promise<string> {
  return new Promise((resolve, reject) => {
    mkdirSync(WORK, { recursive: true });
    const out = createWriteStream(ZIP_PATH);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    out.on('close', () => resolve(ZIP_PATH));
    archive.on('error', reject);
    archive.pipe(out);

    // 5 required spec tables only — no networks.txt / route_networks.txt
    // so the caller's columnExtensions.target table still receives the
    // ALTER (the spec DDL creates networks regardless of CSV presence).
    archive.append('agency_id,agency_name,agency_url,agency_timezone\nA1,Test,https://example.test,Europe/Bucharest\n', { name: 'agency.txt' });
    archive.append('stop_id,stop_name,stop_lat,stop_lon\nS1,Central,46.0,23.0\n', { name: 'stops.txt' });
    archive.append('route_id,agency_id,route_short_name,route_type\nR1,A1,1,3\n', { name: 'routes.txt' });
    archive.append('route_id,service_id,trip_id,direction_id\nR1,WK,R1_0_0,0\n', { name: 'trips.txt' });
    archive.append('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nR1_0_0,08:00:00,08:00:00,S1,1\n', { name: 'stop_times.txt' });
    archive.append('network_id,network_name\nN1,Demo Net\n', { name: 'networks.txt' });
    archive.append('network_id,route_id\nN1,R1\n', { name: 'route_networks.txt' });

    archive.finalize();
  });
}

describe('makeSqlite StaticExtension API', () => {
  it('applies caller-supplied columnExtensions + tableExtensions + fillComputedColumns', async () => {
    await feedZip();
    mkdirSync(OUT_DIR, { recursive: true });

    const hookCalls: string[] = [];
    const { makeSqlite } = await import('../dist/make-sqlite.js');

    const result = await makeSqlite(ZIP_PATH, 'demo-extension', {
      columnExtensions: [
        { table: 'routes', column: ['route_extra', 'TEXT'] },
        { table: 'networks', column: ['network_extra', 'TEXT'] },
      ],
      tableExtensions: {
        _demo: {
          columns: [
            ['k', 'TEXT PRIMARY KEY'],
            ['v', 'TEXT NOT NULL'],
          ],
          rows: [
            { k: 'greeting', v: 'hello' },
            { k: 'mood', v: 'cranky' },
          ],
        },
      },
      fillComputedColumns: (db, ctx) => {
        hookCalls.push(ctx.feedId);
        expect(ctx.routes.length).toBeGreaterThan(0);
        expect(ctx.networks.length).toBeGreaterThan(0);
        expect(ctx.routeNetworks.length).toBeGreaterThan(0);

        // Write a value to a column added via columnExtensions.
        const upd = db.prepare('UPDATE networks SET network_extra = ? WHERE network_id = ?');
        for (const n of ctx.networks) upd.run('#demo', n.network_id as string);

        // Show that hooks CAN do `INSERT` too (caller owns the rows).
        db.prepare('INSERT OR REPLACE INTO _demo (k, v) VALUES (?, ?)').run('hook', 'fired');
      },
    });
    expect(result).not.toBeNull();

    const gz = readFileSync(result!.localPath);
    const raw = gunzipSync(gz);
    const dbPath = join(WORK, 'demo-extension.sqlite3');
    writeFileSync(dbPath, raw);
    const db = new Database(dbPath, { readonly: true });
    try {
      // Caller's ALTER TABLE on routes landed.
      const routeExtra = db.prepare("SELECT route_extra FROM routes WHERE route_id = 'R1'").get() as { route_extra: string | null } | undefined;
      expect(routeExtra).toBeDefined();
      expect(routeExtra?.route_extra).toBeNull(); // hook didn't touch routes

      // Caller's ALTER TABLE on networks + hook's UPDATE both landed.
      const networkExtra = db.prepare("SELECT network_extra FROM networks WHERE network_id = 'N1'").get() as { network_extra: string | null };
      expect(networkExtra.network_extra).toBe('#demo');

      // Pre-supplied tableExtension rows landed.
      const demoRows = db.prepare('SELECT k, v FROM _demo ORDER BY k').all() as Array<{ k: string; v: string }>;
      expect(demoRows).toEqual([
        { k: 'greeting', v: 'hello' },
        { k: 'hook', v: 'fired' },     // overwritten by hook
        { k: 'mood', v: 'cranky' },
      ]);
    } finally {
      db.close();
      rmSync(WORK, { recursive: true, force: true });
    }

    expect(hookCalls).toEqual(['demo-extension']);
  });

  it('omitting extensions keeps the legacy producer-only path', async () => {
    // Same harness as the legacy `make-sqlite-networks.test.ts`
    // (the existing test in this package covers the full flow). Here
    // we only verify that no-extension call doesn't throw and that
    // the legacy network_color gets written.
    mkdirSync(WORK, { recursive: true });
    const legacyZip = join(WORK, 'legacy.gtfs.zip');
    const out = createWriteStream(legacyZip);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const done = new Promise<void>((resolve, reject) => {
      out.on('close', () => resolve());
      archive.on('error', reject);
      archive.pipe(out);
      archive.append('agency_id,agency_name,agency_url,agency_timezone\nA1,Test,https://example.test,Europe/Bucharest\n', { name: 'agency.txt' });
      archive.append('stop_id,stop_name,stop_lat,stop_lon\nS1,Central,46.0,23.0\n', { name: 'stops.txt' });
      archive.append('route_id,agency_id,route_short_name,route_type\nR1,A1,1,3\n', { name: 'routes.txt' });
      archive.append('route_id,service_id,trip_id,direction_id\nR1,WK,R1_0_0,0\n', { name: 'trips.txt' });
      archive.append('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nR1_0_0,08:00:00,08:00:00,S1,1\n', { name: 'stop_times.txt' });
      archive.append('network_id,network_name\nN1,Demo\n', { name: 'networks.txt' });
      archive.append('network_id,route_id\nN1,R1\n', { name: 'route_networks.txt' });
      archive.finalize();
    });
    await done;

    const { makeSqlite } = await import('../dist/make-sqlite.js');
    const result = await makeSqlite(legacyZip, 'legacy-no-ext');
    expect(result).not.toBeNull();

    const gz = readFileSync(result!.localPath);
    const raw = gunzipSync(gz);
    const dbPath = join(WORK, 'legacy.sqlite3');
    writeFileSync(dbPath, raw);
    const db = new Database(dbPath, { readonly: true });
    try {
      // Legacy column extension still lands automatically.
      const color = db.prepare("SELECT network_color FROM networks WHERE network_id = 'N1'").get() as { network_color: string | null };
      expect(color.network_color).toMatch(/^[0-9A-F]{6}$/);
      // Legacy pipeline-internal table is created.
      const count = (db.prepare('SELECT COUNT(*) AS c FROM _neary_config').get() as { c: number }).c;
      expect(count).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
      rmSync(WORK, { recursive: true, force: true });
    }
  });
});
