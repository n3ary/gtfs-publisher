/**
 * make-sqlite.js — convert a GTFS .zip into a SQLite blob (+ gzip).
 *
 * Mirrors the GTFS spec 1:1 into the schema the app's worker reads
 * (apps/web/src/lib/workers/gtfs.worker.ts on the neary side).
 *
 * Pipeline contract:
 *   - Input: a local .zip path passed by fetch-gtfs.js (no download)
 *   - Output: outputs/<feedId>-<hash12>.sqlite3.gz (raw .sqlite3 transient)
 *     Filename embeds the first 12 hex chars of the gzipped-blob sha256
 *     so the R2 URL is content-addressed — clients never fetch stale
 *     bytes from a browser cache after a content change.
 *   - No manifest written — feeds.json carries all the metadata
 *
 * Returns: { localPath, sizeBytes, hash } for the .sqlite3.gz file.
 */

import Database from 'better-sqlite3';
import { parse } from 'csv-parse';
import StreamZip from 'node-stream-zip';

import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';import { createHash } from 'node:crypto';

import { resolveRouteColors, computeNetworkColors } from './lib/route-colors.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUTS = join(ROOT, 'outputs');

// ----- GTFS table schema (must match what the app's worker expects) ----

const SCHEMA = {
  agency: {
    file: 'agency.txt',
    columns: [
      ['agency_id', 'TEXT PRIMARY KEY'],
      ['agency_name', 'TEXT'],
      ['agency_url', 'TEXT'],
      ['agency_timezone', 'TEXT'],
      ['agency_lang', 'TEXT'],
      ['agency_phone', 'TEXT'],
    ],
  },
  routes: {
    file: 'routes.txt',
    columns: [
      ['route_id', 'TEXT PRIMARY KEY'],
      ['agency_id', 'TEXT'],
      ['route_short_name', 'TEXT'],
      ['route_long_name', 'TEXT'],
      ['route_desc', 'TEXT'],
      ['route_type', 'INTEGER'],
      ['route_color', 'TEXT'],
      ['route_text_color', 'TEXT'],
    ],
    indexes: [['routes_agency_idx', '(agency_id)']],
  },
  stops: {
    file: 'stops.txt',
    columns: [
      ['stop_id', 'TEXT PRIMARY KEY'],
      ['stop_code', 'TEXT'],
      ['stop_name', 'TEXT'],
      ['stop_lat', 'REAL'],
      ['stop_lon', 'REAL'],
      ['location_type', 'INTEGER'],
      ['parent_station', 'TEXT'],
      ['wheelchair_boarding', 'INTEGER'],
    ],
  },
  trips: {
    file: 'trips.txt',
    columns: [
      ['trip_id', 'TEXT PRIMARY KEY'],
      ['route_id', 'TEXT'],
      ['service_id', 'TEXT'],
      ['trip_headsign', 'TEXT'],
      ['direction_id', 'INTEGER'],
      ['shape_id', 'TEXT'],
      ['wheelchair_accessible', 'INTEGER'],
      ['bikes_allowed', 'INTEGER'],
    ],
    indexes: [
      ['trips_route_idx', '(route_id)'],
      ['trips_service_idx', '(service_id)'],
      ['trips_shape_idx', '(shape_id)'],
    ],
  },
  // stop_times is 60-90% of a national GTFS sqlite by size. Two knobs:
  //   * Composite PK (trip_id, stop_sequence) is already the natural key,
  //     so we can make the primary-key B-tree BE the table via
  //     WITHOUT ROWID. That drops the implicit rowid column and folds
  //     the previous `(trip_id, stop_sequence)` index into the primary
  //     store — one less full-table B-tree on disk.
  //   * INSERT OR IGNORE keeps the old dedupe behaviour: duplicate
  //     (trip_id, stop_sequence) rows from misbehaving feeds get
  //     dropped instead of aborting the batch transaction.
  stop_times: {
    file: 'stop_times.txt',
    columns: [
      ['trip_id', 'TEXT NOT NULL'],
      ['arrival_time', 'TEXT'],
      ['departure_time', 'TEXT'],
      ['stop_id', 'TEXT'],
      ['stop_sequence', 'INTEGER NOT NULL'],
      ['pickup_type', 'INTEGER'],
      ['drop_off_type', 'INTEGER'],
      ['shape_dist_traveled', 'REAL'],
    ],
    tableConstraints: ['PRIMARY KEY (trip_id, stop_sequence)'],
    withoutRowid: true,
    indexes: [
      ['stop_times_stop_idx', '(stop_id)'],
    ],
  },
  calendar: {
    file: 'calendar.txt',
    columns: [
      ['service_id', 'TEXT PRIMARY KEY'],
      ['monday', 'INTEGER'],
      ['tuesday', 'INTEGER'],
      ['wednesday', 'INTEGER'],
      ['thursday', 'INTEGER'],
      ['friday', 'INTEGER'],
      ['saturday', 'INTEGER'],
      ['sunday', 'INTEGER'],
      ['start_date', 'TEXT'],
      ['end_date', 'TEXT'],
    ],
  },
  calendar_dates: {
    file: 'calendar_dates.txt',
    columns: [
      ['service_id', 'TEXT'],
      ['date', 'TEXT'],
      ['exception_type', 'INTEGER'],
    ],
    indexes: [['calendar_dates_service_date_idx', '(service_id, date)']],
  },
  shapes: {
    file: 'shapes.txt',
    columns: [
      ['shape_id', 'TEXT'],
      ['shape_pt_lat', 'REAL'],
      ['shape_pt_lon', 'REAL'],
      ['shape_pt_sequence', 'INTEGER'],
      ['shape_dist_traveled', 'REAL'],
    ],
    indexes: [['shapes_id_seq_idx', '(shape_id, shape_pt_sequence)']],
  },
  feed_info: {
    file: 'feed_info.txt',
    columns: [
      ['feed_publisher_name', 'TEXT'],
      ['feed_publisher_url', 'TEXT'],
      ['feed_lang', 'TEXT'],
      ['feed_start_date', 'TEXT'],
      ['feed_end_date', 'TEXT'],
      ['feed_version', 'TEXT'],
    ],
  },
  networks: {
    file: 'networks.txt',
    columns: [
      ['network_id', 'TEXT PRIMARY KEY'],
      ['network_name', 'TEXT'],
      ['network_color', 'TEXT'],
    ],
  },
  route_networks: {
    file: 'route_networks.txt',
    columns: [
      ['network_id', 'TEXT'],
      ['route_id', 'TEXT'],
    ],
    indexes: [
      ['route_networks_network_idx', '(network_id)'],
      ['route_networks_route_idx', '(route_id)'],
    ],
  },
};

// GTFS `stop_times.txt` and `shapes.txt` routinely exceed 500 MB
// uncompressed on national feeds. Node's max string length is
// ~512 MB (v8 kMaxLength), so `buf.toString('utf8')` throws for
// anything bigger; loading the parsed result into a single array
// then blows up memory again. We stream from the zip via csv-parse
// (async), yielding rows one at a time.
async function entryExists(zip, filename) {
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
};

// GTFS spec-required files whose absence (or empty output after a
// stream error) means the sqlite is unusable. We refuse to publish
// an empty schedule rather than let a client fail an integrity check.
const REQUIRED_TABLES = ['agency', 'stops', 'routes', 'trips', 'stop_times'];

async function* streamCsvRows(zip, filename) {
  const stream = await zip.stream(filename);
  const parser = stream.pipe(parse(CSV_PARSE_OPTS));
  for await (const row of parser) yield row;
}

// Small tables (routes, networks, route_networks) need to be held in
// memory so post-processing (color resolution) can transform them
// before insertion.
async function collectCsvRows(zip, filename) {
  const rows = [];
  for await (const row of streamCsvRows(zip, filename)) rows.push(row);
  return rows;
}

function createSchema(db) {
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
  db.exec(`CREATE TABLE _neary_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}

function makeRowInserter(db, tableName, columns) {
  const colNames = columns.map(([n]) => n);
  const placeholders = colNames.map(() => '?').join(', ');
  // OR IGNORE: external feeds occasionally violate PK uniqueness (duplicate
  // stop_id rows for parent stations etc.); we drop dupes rather than error.
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${tableName} (${colNames.join(', ')}) VALUES (${placeholders})`);
  const insertBatch = db.transaction((batch) => {
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

function insertRows(db, tableName, columns, rows) {
  if (!rows || rows.length === 0) return 0;
  makeRowInserter(db, tableName, columns)(rows);
  return rows.length;
}

const INSERT_BATCH_SIZE = 5000;
// Chatter cap so a national feed doesn't spam the log. Emit a
// progress line every ~250k rows plus a final total.
const PROGRESS_EVERY = 250_000;

async function streamRowsIntoTable(db, tableName, columns, source, { feedId } = {}) {
  const insertBatch = makeRowInserter(db, tableName, columns);
  const started = Date.now();
  let batch = [];
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

/**
 * @param {string} gtfsZipPath  absolute path to a GTFS .zip
 * @param {string} feedId       e.g. "cluj-napoca"
 * @returns {Promise<{ localPath: string, sizeBytes: number, hash: string } | null>}
 */
export async function makeSqlite(gtfsZipPath, feedId) {
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
    createSchema(db);
    const stats = {};

    // Tables that need the full row set in memory before insertion because
    // a post-processing step reads them (route-color quirk fixer, network
    // color computation). All small in every feed we ship.
    const BUFFERED = new Set(['routes', 'networks', 'route_networks']);

    // Collected during the loop for post-processing.
    let routeRows = null;
    let networkRows = null;
    let routeNetworkRows = null;

    for (const [tableName, spec] of Object.entries(SCHEMA)) {
      if (!(await entryExists(zip, spec.file))) continue;

      if (BUFFERED.has(tableName)) {
        let rows = await collectCsvRows(zip, spec.file);
        if (tableName === 'routes') {
          const result = resolveRouteColors(rows);
          rows = result.rows;
          routeRows = rows;
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

    // Compute and persist network chip colors. All color math lives here
    // in the pipeline — the app reads the pre-computed value verbatim.
    if (networkRows && networkRows.length > 0) {
      const colors = computeNetworkColors(routeRows ?? [], routeNetworkRows ?? [], networkRows);
      const updateColor = db.prepare('UPDATE networks SET network_color = ? WHERE network_id = ?');
      db.transaction(() => {
        for (const [netId, color] of colors) updateColor.run(color, netId);
      })();
      console.log(`[make-sqlite] ${feedId}: network colors — ${[...colors.entries()].map(([id, c]) => `${id}=#${c}`).join(', ')}`);
    }

    // Write per-feed config to _neary_config from the feed's config.json.
    const configPath = join(ROOT, 'feeds', feedId, 'config.json');
    if (existsSync(configPath)) {
      const feedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      if (feedConfig.timing) {
        db.prepare('INSERT INTO _neary_config (key, value) VALUES (?, ?)')
          .run('timing', JSON.stringify(feedConfig.timing));
        console.log(`[make-sqlite] ${feedId}: wrote timing config to _neary_config`);
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
