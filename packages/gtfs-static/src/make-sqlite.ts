/**
 * make-sqlite.ts — convert a GTFS .zip into a SQLite blob (+ gzip).
 *
 * Mirrors the GTFS spec 1:1 into the schema the app's worker reads
 * (apps/web/src/lib/workers/gtfs.worker.ts on the neary side).
 *
 * Pipeline contract:
 *   - Input: a local .zip path passed by fetch-gtfs.ts (no download)
 *   - Output: outputs/<feedId>-<hash12>.sqlite3.gz (raw .sqlite3 transient)
 *     Filename embeds the first 12 hex chars of the gzipped-blob sha256
 *     so the R2 URL is content-addressed — clients never fetch stale
 *     bytes from a browser cache after a content change.
 *   - No manifest written — feeds.json carries all the metadata
 *
 * Per-feed additions (`ALTER TABLE` columns, internal tables, computed
 * values) come in through the optional third argument `StaticExtension`
 * — see ./lib/extension.ts. Without it, the build falls back to the
 * legacy producer-only defaults (network_color column, _neary_config
 * table, network color computed from routes + networks). Those defaults
 * exist only so current callers (the CLI, the in-tree tests) keep
 * working; new adapter-based callers pass their own extension object.
 */

import Database from 'better-sqlite3';
import { parse } from 'csv-parse';
import StreamZip from 'node-stream-zip';

import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

import { resolveRouteColors, computeNetworkColors } from './lib/route-colors.js';
import type { SqliteFile } from './lib/types.js';
import type { StaticExtension, ColumnExtension, TableExtension } from './lib/extension.js';
import { OUTPUTS } from './fetch-gtfs.js';
import { SCHEMA, REQUIRED_TABLES, type ColumnSpec } from '@n3ary/gtfs-spec/sql';
import { COLUMN_EXTENSIONS, TABLE_EXTENSIONS } from './extensions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// The spec DDL is the canonical contract for the 11 standard GTFS
// Schedule tables (agency, stops, routes, trips, stop_times, calendar,
// calendar_dates, shapes, feed_info, networks, route_networks).
// Per-feed additions come in via the `extensions` argument to
// makeSqlite(); without it the legacy producer-only defaults from
// ./extensions.ts run (see ./lib/extension.ts for the new contract).

// GTFS `stop_times.txt` and `shapes.txt` routinely exceed 500 MB
// uncompressed on national feeds. Node's max string length is
// ~512 MB (v8 kMaxLength), so `buf.toString('utf8')` throws for
// anything bigger; loading the parsed result into a single array
// then blows up memory again. We stream from the zip via csv-parse
// (async), yielding rows one at a time.
async function entryExists(zip: StreamZip.StreamZipAsync, filename: string): Promise<boolean> {
  try {
    return !!(await zip.entry(filename));
  } catch {
    return false;
  }
}

const CSV_PARSE_OPTS = {
  columns: true,
  skip_empty_lines: true,
  relax_quotes: true,
  relax_column_count: true,
  trim: true,
  bom: true,
} as const;

// GTFS spec-required files whose absence (or empty output after a
// stream error) means the sqlite is unusable. We refuse to publish
// an empty schedule rather than let a client fail an integrity check.
// (REQUIRED_TABLES is imported from @n3ary/gtfs-spec/sql — see top of file.)

async function* streamCsvRows(zip: StreamZip.StreamZipAsync, filename: string): AsyncGenerator<Record<string, string>> {
  const stream = await zip.stream(filename);
  const parser = stream.pipe(parse(CSV_PARSE_OPTS));
  for await (const row of parser) yield row as Record<string, string>;
}

// Small tables (routes, networks, route_networks) need to be held in
// memory so post-processing (color resolution) can transform them
// before insertion.
async function collectCsvRows(zip: StreamZip.StreamZipAsync, filename: string): Promise<Record<string, string>[]> {
  const rows: Record<string, string>[] = [];
  for await (const row of streamCsvRows(zip, filename)) rows.push(row);
  return rows;
}

function createSchema(db: Database.Database, extensions?: StaticExtension): void {
  // 1. Spec DDL — all 11 public GTFS Schedule tables, applied as the
  //    shared @n3ary/gtfs-spec/sql SCHEMA object so static and (later)
  //    the gtfs-rt package agree on the same shape.
  for (const [tableName, spec] of Object.entries(SCHEMA)) {
    const cols = spec.columns.map(([n, t]) => `${n} ${t}`);
    const constraints = spec.tableConstraints ?? [];
    const body = [...cols, ...constraints].join(', ');
    const opts = spec.withoutRowid ? ' WITHOUT ROWID' : '';
    db.exec(`CREATE TABLE ${tableName} (${body})${opts};`);
    for (const [idxName, idxCols] of spec.indexes ?? []) {
      db.exec(`CREATE INDEX ${idxName} ON ${tableName} ${idxCols};`);
    }
  }
  // 2. Column extensions — ALTER TABLE <spec_table> ADD COLUMN. Must run
  //    after the spec DDL (target tables must exist). Sources, in order:
  //      a) caller-supplied `extensions.columnExtensions`,
  //      b) legacy producer-only defaults from ./extensions.ts.
  const columnExtensions: ReadonlyArray<ColumnExtension> =
    extensions?.columnExtensions ?? COLUMN_EXTENSIONS;
  for (const { table, column } of columnExtensions) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column[0]} ${column[1]};`);
  }
  // 3. Table extensions — pipeline-internal tables that aren't part of
  //    any GTFS feed (e.g. _neary_config). Sources, same precedence.
  const tableExtensions: Readonly<Record<string, TableExtension>> | undefined = extensions?.tableExtensions;
  const tableEntries: Array<[string, { columns: ColumnSpec[]; rows?: ReadonlyArray<Record<string, unknown>> }]> = tableExtensions
    ? Object.entries(tableExtensions)
    : Object.entries(TABLE_EXTENSIONS).map(([name, spec]) => [name, { columns: spec.columns }]);
  for (const [tableName, ext] of tableEntries) {
    const cols = ext.columns.map(([n, t]) => `${n} ${t}`).join(', ');
    db.exec(`CREATE TABLE ${tableName} (${cols});`);
  }
}

/**
 * Insert pre-computed rows into table extensions. Run after the spec
 * tables are loaded and after `fillComputedColumns` so the hook can
 * order data relative to it. Skipped when extensions is undefined (the
 * legacy default writes its own `_neary_config` rows from
 * `feeds/<id>/config.json` — see below).
 */
function insertTableExtensionRows(
  db: Database.Database,
  extensions: StaticExtension | undefined,
  tag: string,
): void {
  if (!extensions?.tableExtensions) return;
  for (const [tableName, ext] of Object.entries(extensions.tableExtensions)) {
    if (!ext.rows || ext.rows.length === 0) continue;
    const cols = ext.columns.map(([n]) => n);
    const placeholders = cols.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`);
    const insertBatch = db.transaction((rows: ReadonlyArray<Record<string, unknown>>) => {
      for (const row of rows) {
        stmt.run(cols.map((c) => row[c] ?? null));
      }
    });
    insertBatch(ext.rows);
    console.log(`${tag}: ${tableName} — ${ext.rows.length} extension row(s) inserted`);
  }
}

function makeRowInserter(db: Database.Database, tableName: string, columns: ColumnSpec[]) {
  const colNames = columns.map(([n]) => n);
  const placeholders = colNames.map(() => '?').join(', ');
  // OR IGNORE: external feeds occasionally violate PK uniqueness (duplicate
  // stop_id rows for parent stations etc.); we drop dupes rather than error.
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${tableName} (${colNames.join(', ')}) VALUES (${placeholders})`);
  const insertBatch = db.transaction((batch: Array<Record<string, string>>) => {
    for (const row of batch) {
      const values = colNames.map((c) => {
        const v = row[c];
        return v === undefined || v === '' ? null : v;
      });
      stmt.run(values);
    }
  });
  return insertBatch;
}

function insertRows(db: Database.Database, tableName: string, columns: ColumnSpec[], rows: Array<Record<string, string>>): number {
  if (!rows || rows.length === 0) return 0;
  makeRowInserter(db, tableName, columns)(rows);
  return rows.length;
}

const INSERT_BATCH_SIZE = 5000;
// Chatter cap so a national feed doesn't spam the log. Emit a
// progress line every ~250k rows plus a final total.
const PROGRESS_EVERY = 250_000;

async function streamRowsIntoTable(
  db: Database.Database,
  tableName: string,
  columns: ColumnSpec[],
  source: AsyncGenerator<Record<string, string>>,
  { feedId }: { feedId?: string } = {},
): Promise<number> {
  const insertBatch = makeRowInserter(db, tableName, columns);
  const started = Date.now();
  let batch: Array<Record<string, string>> = [];
  let total = 0;
  let nextProgress = PROGRESS_EVERY;
  const tag = feedId ? `[make-sqlite] ${feedId}` : '[make-sqlite]';
  for await (const row of source) {
    batch.push(row);
    if (batch.length >= INSERT_BATCH_SIZE) {
      insertBatch(batch);
      total += batch.length;
      batch = [];
      if (total >= nextProgress) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const rate = Math.round(total / Math.max(1, (Date.now() - started) / 1000));
        console.log(`${tag}: ${tableName} — ${total.toLocaleString()} rows (${rate.toLocaleString()}/s, ${elapsed}s)`);
        nextProgress += PROGRESS_EVERY;
      }
    }
  }
  if (batch.length > 0) {
    insertBatch(batch);
    total += batch.length;
  }
  return total;
}

export async function makeSqlite(
  gtfsZipPath: string,
  feedId: string,
  extensions?: StaticExtension,
): Promise<SqliteFile | null> {
  mkdirSync(OUTPUTS, { recursive: true });
  const dbPath = join(OUTPUTS, `${feedId}.sqlite3`);
  const gzPath = `${dbPath}.gz`;

  if (existsSync(dbPath)) unlinkSync(dbPath);

  const zip = new StreamZip.async({ file: gtfsZipPath });
  const db = new Database(dbPath);
  // page_size MUST be set before any DDL — SQLite ignores changes
  // once the file has content. 8192 is chosen over the 4096 default
  // because row-heavy tables (stop_times, shapes) pack denser at 8K.
  db.pragma('page_size = 8192');
  // Bulk-load pragmas. Durability doesn't matter here — the sqlite
  // is rebuilt from the raw GTFS zip if the process dies mid-write.
  // Disabling the journal + fsync avoids two things at national-feed
  // scale: (a) the readonly-database errors we saw when the rollback
  // journal creation/deletion cadence tripped over macOS APFS, and
  // (b) the 5–10x throughput cost of syncing on every batch commit.
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('temp_store = MEMORY');

  try {
    createSchema(db, extensions);
    const stats: Record<string, number> = {};

    // Tables that need the full row set in memory before insertion because
    // a post-processing step reads them (route-color quirk fixer, network
    // color computation). All small in every feed we ship.
    const BUFFERED = new Set(['routes', 'networks', 'route_networks']);

    // Collected during the loop for post-processing.
    let routeRows: Array<Record<string, unknown>> | null = null;
    let networkRows: Array<Record<string, unknown>> | null = null;
    let routeNetworkRows: Array<Record<string, unknown>> | null = null;

    // Iterate SCHEMA — all 11 public GTFS Schedule tables, including
    // networks + route_networks. Producer-only extensions (the
    // network_color ALTER, the _neary_config table) have no CSV source
    // in the .zip, so they're created in createSchema() and never
    // appear in this loop.
    for (const [tableName, spec] of Object.entries(SCHEMA)) {
      if (!(await entryExists(zip, spec.file))) continue;

      if (BUFFERED.has(tableName)) {
        let rows: Array<Record<string, string>> = await collectCsvRows(zip, spec.file);
        if (tableName === 'routes') {
          const result = resolveRouteColors(rows);
          rows = result.rows as Array<Record<string, string>>;
          routeRows = result.rows;
          for (const line of result.logs) {
            console.log(`[make-sqlite] ${feedId}: routes — ${line}`);
          }
        } else if (tableName === 'networks') {
          networkRows = rows;
        } else if (tableName === 'route_networks') {
          routeNetworkRows = rows;
        }
        stats[tableName] = insertRows(db, tableName, spec.columns, rows);
      } else {
        // Stream: never materialise the whole file. Required for
        // national feeds where stop_times.txt / shapes.txt exceed
        // Node's max string length or would OOM the parser.
        stats[tableName] = await streamRowsIntoTable(
          db,
          tableName,
          spec.columns,
          streamCsvRows(zip, spec.file),
          { feedId },
        );
      }
    }

    // Fail loud if a required table came out empty. The producer
    // MUST NOT ship a sqlite that would fail the client integrity
    // check downstream — emitting nothing is safer than emitting
    // a schedule that silently drops stop_times or trips.
    const missing = REQUIRED_TABLES.filter((t) => !stats[t] || stats[t] === 0);
    if (missing.length > 0) {
      throw new Error(
        `Required GTFS table(s) empty or missing for feed "${feedId}": ${missing.join(', ')}`,
      );
    }

    // Per-feed additions: either the caller's hook (preferred — adapter
    // owns the algorithm) or the legacy producer-only defaults (kept so
    // the CLI and existing in-tree tests work without an adapter).
    if (extensions?.fillComputedColumns) {
      await extensions.fillComputedColumns(db, {
        feedId,
        routes: (routeRows ?? []) as ReadonlyArray<Record<string, unknown>>,
        networks: (networkRows ?? []) as ReadonlyArray<Record<string, unknown>>,
        routeNetworks: (routeNetworkRows ?? []) as ReadonlyArray<Record<string, unknown>>,
      });
      insertTableExtensionRows(db, extensions, `[make-sqlite] ${feedId}`);
    } else {
      // Compute and persist network chip colors. All color math lives
      // here in the pipeline — the app reads the pre-computed value
      // verbatim. (Legacy producer-only path; the adapter equivalent
      // replaces this with `fillComputedColumns`.)
      if (networkRows && networkRows.length > 0) {
        const colors = computeNetworkColors(routeRows as never, routeNetworkRows as never, networkRows as never);
        const updateColor = db.prepare('UPDATE networks SET network_color = ? WHERE network_id = ?');
        db.transaction(() => {
          for (const [netId, color] of colors) updateColor.run(color, netId);
        })();
        console.log(`[make-sqlite] ${feedId}: network colors — ${[...colors.entries()].map(([id, c]) => `${id}=#${c}`).join(', ')}`);
      }

      // Write per-feed config to _neary_config from the feed's config.json.
      // Legacy producer-only path — adapter-driven builds supply the
      // rows via `tableExtensions._neary_config.rows` instead.
      const configPath = join(ROOT, 'feeds', feedId, 'config.json');
      if (existsSync(configPath)) {
        const feedConfig = JSON.parse(readFileSync(configPath, 'utf8')) as { timing?: unknown };
        if (feedConfig.timing) {
          db.prepare('INSERT INTO _neary_config (key, value) VALUES (?, ?)')
            .run('timing', JSON.stringify(feedConfig.timing));
          console.log(`[make-sqlite] ${feedId}: wrote timing config to _neary_config`);
        }
      }
    }

    console.log(`[make-sqlite] ${feedId}: ` +
      Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' '));

    db.exec('VACUUM;');
    db.exec('ANALYZE;');
  } finally {
    db.close();
    await zip.close();
  }

  await pipeline(createReadStream(dbPath), createGzip({ level: 9 }), createWriteStream(gzPath));
  const sizeBytes = statSync(gzPath).size;
  const rawSize = statSync(dbPath).size;
  unlinkSync(dbPath); // keep only the .gz

  const hash = 'sha256-' + createHash('sha256').update(readFileSync(gzPath)).digest('hex');

  // Content-address the filename so cache TTL on the R2 URL is
  // irrelevant to correctness: a content change yields a new hash and
  // a new URL. Old URLs point at content that will never change; new
  // URLs point at fresh content. Browsers can never serve stale bytes
  // at a URL that's already flipped to something else.
  const hash12 = hash.replace(/^sha256-/, '').slice(0, 12);
  const finalPath = join(OUTPUTS, `${feedId}-${hash12}.sqlite3.gz`);
  if (existsSync(finalPath)) unlinkSync(finalPath);
  renameSync(gzPath, finalPath);

  console.log(`[make-sqlite] ${feedId}: raw=${(rawSize / 1024).toFixed(1)}KB gz=${(sizeBytes / 1024).toFixed(1)}KB (${((sizeBytes / rawSize) * 100).toFixed(0)}%) → ${feedId}-${hash12}.sqlite3.gz`);
  return { localPath: finalPath, sizeBytes, hash };
}