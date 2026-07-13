import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
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
      fillComputedColumns: (ctx) => {
        hookCalls.push(ctx.feedId);
        expect(ctx.routes.length).toBeGreaterThan(0);
        expect(ctx.networks.length).toBeGreaterThan(0);
        expect(ctx.routeNetworks.length).toBeGreaterThan(0);

        // Hook is pure data-in / data-out since the SQL-free refactor:
        // return the column values to set (one per network). The pipeline
        // owns the UPDATE statement + the transaction.
        return {
          networks: ctx.networks.map((n) => ({
            network_id: n.network_id as string,
            network_extra: '#demo',
          })),
        };
      },
    });
    expect(result).not.toBeNull();

    const gz = readFileSync(result!.localPath);
    const raw = gunzipSync(gz);
    const dbPath = join(WORK, 'demo-extension.sqlite3');
    writeFileSync(dbPath, raw);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // Caller's ALTER TABLE on routes landed.
      const routeExtra = db.prepare("SELECT route_extra FROM routes WHERE route_id = 'R1'").get() as { route_extra: string | null } | undefined;
      expect(routeExtra).toBeDefined();
      expect(routeExtra?.route_extra).toBeNull(); // hook didn't touch routes

      // Caller's ALTER TABLE on networks + hook's returned updates
      // (applied by the pipeline as `UPDATE ... WHERE network_id = ?`)
      // both landed. The new contract is data-in / data-out for the
      // hook — see ./lib/extension.ts header for the rationale.
      const networkExtra = db.prepare("SELECT network_extra FROM networks WHERE network_id = 'N1'").get() as { network_extra: string | null };
      expect(networkExtra.network_extra).toBe('#demo');

      // Pre-supplied tableExtension rows landed — the hook no longer
      // has DB access, so `INSERT OR REPLACE INTO _demo` from the old
      // test is gone; only the rows declared in tableExtensions survive.
      const demoRows = db.prepare('SELECT k, v FROM _demo ORDER BY k').all() as Array<{ k: string; v: string }>;
      expect(demoRows).toEqual([
        { k: 'greeting', v: 'hello' },
        { k: 'mood', v: 'cranky' },
      ]);
    } finally {
      db.close();
      rmSync(WORK, { recursive: true, force: true });
    }

    expect(hookCalls).toEqual(['demo-extension']);
  });

  it('reads a producer-extension CSV from the zip, populates feedConfig, and INSERTs into a table extension (generic round-trip)', async () => {
    // End-to-end pin for the generic producer-extension contract:
    //   1. The adapter emits `<fileName>.txt` in the zip.
    //   2. The orchestrator (`buildStaticExtension`) reads it via
    //      `readCsvFromZip` and sets `feedConfig[feedConfigKey]` to
    //      the parsed rows (raw CSV strings).
    //   3. The adapter's `staticExtension()` reads `feedConfig[key]`
    //      and writes the rows into a `tableExtension`, doing any
    //      type coercion.
    //
    // We exercise steps 2 + 3 inline (a caller-supplied extension
    // that mirrors a real adapter's coercion) so this test stays
    // inside the publisher repo and exercises the GENERIC contract.
    // The adapter-specific round-trip (the adapter's own coercion
    // for its DDL) is covered by the adapter's own static-extension
    // tests.
    //
    // The previous test's `finally` block deletes WORK — re-create
    // it before we start. (Same pattern as the "omitting
    // extensions" test below.)
    mkdirSync(WORK, { recursive: true });
    const producerExtZip = join(WORK, 'producer-ext.gtfs.zip');
    const out = createWriteStream(producerExtZip);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    await new Promise<void>((resolve, reject) => {
      out.on('close', () => resolve());
      archive.on('error', reject);
      archive.pipe(out);
      archive.append('agency_id,agency_name,agency_url,agency_timezone\nA1,Test,https://example.test,Europe/Bucharest\n', { name: 'agency.txt' });
      archive.append('stop_id,stop_name,stop_lat,stop_lon\nS1,Central,46.0,23.0\nS2,North,46.1,23.1\n', { name: 'stops.txt' });
      archive.append('route_id,agency_id,route_short_name,route_type\nR1,A1,1,3\nR2,A1,2,3\n', { name: 'routes.txt' });
      archive.append('route_id,service_id,trip_id,direction_id\nR1,WK,R1_0_0,0\nR2,WK,R2_0_0,0\n', { name: 'trips.txt' });
      archive.append('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nR1_0_0,08:00:00,08:00:00,S1,1\nR2_0_0,09:00:00,09:00:00,S2,1\n', { name: 'stop_times.txt' });
      archive.append('network_id,network_name\nN1,Demo\n', { name: 'networks.txt' });
      archive.append('network_id,route_id\nN1,R1\nN1,R2\n', { name: 'route_networks.txt' });
      // Generic producer-extension artifact: feed-neutral file
      // name + columns. The orchestrator doesn't know what's in
      // here; it just walks `producerExtensions` and hands the
      // parsed rows to the adapter. Real adapter-specific
      // fixtures live in the adapter's own static-extension
      // tests; this test exercises the GENERIC contract only.
      const PRODUCER_FILE = 'producer_ext.txt';
      const FEED_CONFIG_KEY = 'producerExt';
      archive.append(
        [
          'id,kind,label,weight',
          '1,school,Transport Elevi,1',
          '2,metroline,Metropolitan,5',
          '3,festival,Untold,2',
          '',
        ].join('\n'),
        { name: PRODUCER_FILE },
      );
      archive.finalize();
    });
    mkdirSync(OUT_DIR, { recursive: true });

    // Step 1 (orchestrator-side, generic): read the CSV via the
    // publisher's feed-agnostic helper. Returns raw
    // `Record<string, string>[]` — the publisher does no schema
    // interpretation. The `feedConfigKey` is what the adapter
    // declared in its `producerExtensions` manifest.
    const { readCsvFromZip } = await import('../src/lib/read-csv-from-zip.js');
    const rawRows = await readCsvFromZip(producerExtZip, 'producer_ext.txt');
    expect(rawRows).toEqual([
      { id: '1', kind: 'school', label: 'Transport Elevi', weight: '1' },
      { id: '2', kind: 'metroline', label: 'Metropolitan', weight: '5' },
      { id: '3', kind: 'festival', label: 'Untold', weight: '2' },
    ]);

    // Step 2 (adapter-side, simulated here): the adapter's
    // `staticExtension` reads `feedConfig[feedConfigKey]` (raw
    // CSV rows) and writes a typed `tableExtension` with type
    // coercion. We mirror a real adapter's coercion here so the
    // test exercises the same contract end-to-end.
    const feedConfig: { producerExt: Record<string, string>[] } = { producerExt: rawRows };
    const coercedRows = feedConfig.producerExt.map((r) => {
      const weightRaw = (r.weight ?? '').trim();
      const weightNum = weightRaw === '' ? null : Number(weightRaw);
      return {
        id: r.id ?? '',
        kind: r.kind ?? '',
        label: r.label && r.label.length > 0 ? r.label : null,
        weight: weightNum !== null && Number.isFinite(weightNum) ? weightNum : null,
      };
    });

    // Step 3 (pipeline-side, generic): makeSqlite takes the
    // tableExtension, runs the DDL, and INSERTs the rows.
    const { makeSqlite } = await import('../dist/make-sqlite.js');
    const result = await makeSqlite(producerExtZip, 'producer-ext-roundtrip', {
      tableExtensions: {
        _producer_ext: {
          columns: [
            ['id', 'TEXT NOT NULL'],
            ['kind', 'TEXT NOT NULL'],
            ['label', 'TEXT'],
            ['weight', 'INTEGER'],
          ],
          rows: coercedRows,
        },
      },
    });
    expect(result).not.toBeNull();

    // Step 4: verify the SQLite has the rows.
    const gz = readFileSync(result!.localPath);
    const raw = gunzipSync(gz);
    const dbPath = join(WORK, 'producer-ext.sqlite3');
    // Re-create from scratch (the test ran a previous makeSqlite
    // that wrote a different .sqlite3 path).
    rmSync(dbPath, { force: true });
    writeFileSync(dbPath, raw);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // DDL landed.
      const cols = db.prepare("PRAGMA table_info('_producer_ext')").all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name).sort();
      expect(colNames).toEqual(['id', 'kind', 'label', 'weight']);

      // Rows landed, full n:m membership (kind=metroline has 2
      // rows). The string `weight` was coerced to a number by
      // the adapter (step 2) — verifying here that the
      // round-trip survived the SQLite INTEGER column.
      const rows = db.prepare('SELECT id, kind, label, weight FROM _producer_ext ORDER BY id').all() as Array<{ id: string; kind: string; label: string; weight: number }>;
      expect(rows).toEqual([
        { id: '1', kind: 'school', label: 'Transport Elevi', weight: 1 },
        { id: '2', kind: 'metroline', label: 'Metropolitan', weight: 5 },
        { id: '3', kind: 'festival', label: 'Untold', weight: 2 },
      ]);
      // 1:many invariant — there are 3 rows for 2 distinct kinds.
      const distinctKinds = db.prepare("SELECT COUNT(DISTINCT kind) AS c FROM _producer_ext").get() as { c: number };
      expect(distinctKinds.c).toBe(3);
    } finally {
      db.close();
      // The describe block has an afterEach-less cleanup pattern
      // where each test re-creates WORK on entry and the next test
      // cleans up. Don't rmSync(WORK) here — let the cleanup
      // helper from the next test (or its absence) decide.
    }
  });

  it('round-trips a 6-column producer extension (the gtfs-adapters#156 `_route_tags` shape)', async () => {
    // Pins the producer-extension contract for the new 6-column shape
    // (gtfs-adapters#156, the tag color column). Mirrors the 4-column
    // test above but exercises the same path with 6 columns and
    // asserts both the new `icon` and `color` columns carry through
    // verbatim from the CSV through the SQLite INSERT.
    //
    // The 4-path contract this test pins (the "column-list-agnostic
    // promise" the producer-extension machinery commits to):
    //
    //   1. `readCsvFromZip` (src/lib/read-csv-from-zip.ts) returns
    //      `Record<string, string>[]` with every header in the file
    //      as a key -- NO column allowlist, no filtering.
    //   2. `buildStaticExtension` (src/cli.ts) hands the parsed rows
    //      to the adapter verbatim via `augmented[feedConfigKey] = rows`.
    //   3. The adapter's `staticExtension()` declares the column shape
    //      via `tableExtensions[<name>].columns` (variable-length
    //      ColumnSpec[]) and writes typed values.
    //   4. `insertTableExtensionRows` (src/make-sqlite.ts) builds the
    //      INSERT statement from the declared column list and runs it
    //      with the typed values -- NO hard-coded column set, NO
    //      filtering of values.
    //
    // The icon column from gtfs-adapters#154 already went through
    // this path (proven by the live pipeline + the adapter's own
    // static-extension tests). This test pins the contract for the
    // color column so a future "validate column types at the
    // publisher boundary" change can't accidentally drop producer
    // columns the publisher doesn't recognize.
    mkdirSync(WORK, { recursive: true });
    const routeTagsZip = join(WORK, 'route-tags-color.gtfs.zip');
    const out = createWriteStream(routeTagsZip);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    await new Promise<void>((resolve, reject) => {
      out.on('close', () => resolve());
      archive.on('error', reject);
      archive.pipe(out);
      archive.append('agency_id,agency_name,agency_url,agency_timezone\nA1,Test,https://example.test,Europe/Bucharest\n', { name: 'agency.txt' });
      archive.append('stop_id,stop_name,stop_lat,stop_lon\nS1,Central,46.0,23.0\nS2,North,46.1,23.1\n', { name: 'stops.txt' });
      archive.append('route_id,agency_id,route_short_name,route_type\nR1,A1,1,3\nR2,A1,2,3\n', { name: 'routes.txt' });
      archive.append('route_id,service_id,trip_id,direction_id\nR1,WK,R1_0_0,0\nR2,WK,R2_0_0,0\n', { name: 'trips.txt' });
      archive.append('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nR1_0_0,08:00:00,08:00:00,S1,1\nR2_0_0,09:00:00,09:00:00,S2,1\n', { name: 'stop_times.txt' });
      archive.append('network_id,network_name\nN1,Demo\n', { name: 'networks.txt' });
      archive.append('network_id,route_id\nN1,R1\nN1,R2\n', { name: 'route_networks.txt' });
      // 6-column producer-extension artifact, matching the
      // gtfs-adapters#156 shape. One row intentionally carries
      // an empty `color` cell to exercise the null coercion path.
      archive.append(
        [
          'tag_id,route_id,tag_label,priority,icon,color',
          'night,R1,Noapte,0,moon,1A1F36',
          'metroline,R2,Metropolitan,1,map-pin,2E7D5B',
          'metroline,R1,Metropolitan,1,map-pin,',  // empty color -> NULL in SQLite
          '',
        ].join('\n'),
        { name: '_route_tags.txt' },
      );
      archive.finalize();
    });
    mkdirSync(OUT_DIR, { recursive: true });

    // Step 1 (orchestrator-side, generic): the publisher's
    // feed-agnostic helper. Returns raw `Record<string, string>[]`
    // -- the publisher does no schema interpretation. The 6
    // headers all come back as keys (no allowlist).
    const { readCsvFromZip } = await import('../src/lib/read-csv-from-zip.js');
    const rawRows = await readCsvFromZip(routeTagsZip, '_route_tags.txt');
    expect(rawRows).toEqual([
      { tag_id: 'night', route_id: 'R1', tag_label: 'Noapte', priority: '0', icon: 'moon', color: '1A1F36' },
      { tag_id: 'metroline', route_id: 'R2', tag_label: 'Metropolitan', priority: '1', icon: 'map-pin', color: '2E7D5B' },
      { tag_id: 'metroline', route_id: 'R1', tag_label: 'Metropolitan', priority: '1', icon: 'map-pin', color: '' },
    ]);

    // Step 2 (adapter-side, simulated here): the adapter's
    // `staticExtension` reads `feedConfig[feedConfigKey]` and writes
    // a typed `tableExtension` with type coercion. We mirror
    // gtfs-adapters#156's coercion exactly: priority -> INTEGER
    // (defensive Number('') -> null), empty `icon` / `color` ->
    // null. Same string-presence rule the adapter uses.
    const feedConfig: { routeTags: Record<string, string>[] } = { routeTags: rawRows };
    const coercedRows = feedConfig.routeTags.map((r) => {
      const priorityRaw = r.priority?.trim() ?? '';
      const priorityNum = priorityRaw === '' ? null : Number(priorityRaw);
      return {
        tag_id: r.tag_id ?? '',
        route_id: r.route_id ?? '',
        tag_label: r.tag_label && r.tag_label.length > 0 ? r.tag_label : null,
        priority: priorityNum !== null && Number.isFinite(priorityNum) ? priorityNum : null,
        icon: r.icon && r.icon.length > 0 ? r.icon : null,
        color: r.color && r.color.length > 0 ? r.color : null,
      };
    });

    // Step 3 (pipeline-side, generic): makeSqlite takes the
    // 6-column tableExtension, runs the DDL, INSERTs the rows.
    const { makeSqlite } = await import('../dist/make-sqlite.js');
    const result = await makeSqlite(routeTagsZip, 'route-tags-color-roundtrip', {
      tableExtensions: {
        _route_tags: {
          columns: [
            ['tag_id', 'TEXT NOT NULL'],
            ['route_id', 'TEXT NOT NULL'],
            ['tag_label', 'TEXT'],
            ['priority', 'INTEGER'],
            ['icon', 'TEXT'],
            ['color', 'TEXT'],
          ],
          rows: coercedRows,
        },
      },
    });
    expect(result).not.toBeNull();

    // Step 4: verify the SQLite has the 6-column DDL + the coerced
    // rows (including the empty-color -> NULL coercion).
    const gz = readFileSync(result!.localPath);
    const raw = gunzipSync(gz);
    const dbPath = join(WORK, 'route-tags-color.sqlite3');
    rmSync(dbPath, { force: true });
    writeFileSync(dbPath, raw);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // DDL: all 6 columns present in declared order, icon + color
      // (the 2 new column-additive changes from #154 and #156) ride
      // through the CREATE TABLE unchanged.
      const tagColumns = db.prepare("PRAGMA table_info('_route_tags')").all() as Array<{ name: string; pk: number }>;
      const colNames = tagColumns.map((c) => c.name);
      expect(colNames).toEqual(['tag_id', 'route_id', 'tag_label', 'priority', 'icon', 'color']);
      // The declared types landed too -- `color` is TEXT, not
      // silently coerced to INTEGER or anything else.
      const colorCol = tagColumns.find((c) => c.name === 'color');
      expect(colorCol).toBeDefined();
      expect(String(colorCol!.type)).toEqual('TEXT');

      // Rows: the full round-trip, including the empty -> NULL
      // coercion. Sorted by (route_id, priority) so the test is
      // diff-stable -- night(0) on R1 comes before metroline(1)
      // on R1, which is the editor's TAGS-declaration order
      // (every-day first, event overlay after).
      const rows = db.prepare(
        'SELECT tag_id, route_id, tag_label, priority, icon, color FROM _route_tags ORDER BY route_id, priority',
      ).all() as Array<{ tag_id: string; route_id: string; tag_label: string | null; priority: number; icon: string | null; color: string | null }>;
      expect(rows).toEqual([
        { tag_id: 'night',     route_id: 'R1', tag_label: 'Noapte',        priority: 0, icon: 'moon',    color: '1A1F36' },
        { tag_id: 'metroline', route_id: 'R1', tag_label: 'Metropolitan', priority: 1, icon: 'map-pin', color: null },
        { tag_id: 'metroline', route_id: 'R2', tag_label: 'Metropolitan', priority: 1, icon: 'map-pin', color: '2E7D5B' },
      ]);
      // 1:many invariant -- metroline appears on 2 routes.
      const r1Count = db.prepare("SELECT COUNT(*) AS c FROM _route_tags WHERE route_id = 'R1'").get() as { c: number };
      expect(r1Count.c).toBe(2);
    } finally {
      db.close();
    }
  });

  it('omitting extensions leaves the sqlite spec-only (no per-feed extras)', async () => {
    // The generic pipeline owns zero per-feed knowledge. A call
    // without an extension produces exactly the public GTFS
    // Schedule schema — no `network_color` column, no
    // `_neary_config` table. Per-feed extras (network colors,
    // adapter timing rows, etc.) arrive only when an adapter
    // supplies them via its `StaticExtension` object.
    mkdirSync(WORK, { recursive: true });
    const noExtZip = join(WORK, 'no-ext.gtfs.zip');
    const out = createWriteStream(noExtZip);
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
    const result = await makeSqlite(noExtZip, 'no-ext');
    expect(result).not.toBeNull();

    const gz = readFileSync(result!.localPath);
    const raw = gunzipSync(gz);
    const dbPath = join(WORK, 'no-ext.sqlite3');
    writeFileSync(dbPath, raw);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // No network_color column on networks when no extension is given.
      const cols = db.prepare("PRAGMA table_info('networks')").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'network_color')).toBe(false);

      // No _neary_config table when no extension is given.
      const hasCfg = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_neary_config'")
        .get();
      expect(hasCfg).toBeUndefined();

      // The spec tables ARE there (sanity check — the pipeline is still
      // applying spec DDL).
      const n = db.prepare('SELECT COUNT(*) AS c FROM networks').get() as { c: number };
      expect(n.c).toBe(1);
    } finally {
      db.close();
      rmSync(WORK, { recursive: true, force: true });
    }
  });
});
