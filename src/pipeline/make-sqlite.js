/**
 * make-sqlite.js — convert a GTFS .zip into a SQLite blob (+ gzip).
 *
 * Mirrors the GTFS spec 1:1 into the schema the app's worker reads
 * (apps/web/src/lib/workers/gtfs.worker.ts on the neary side).
 *
 * Pipeline contract:
 *   - Input: a local .zip path passed by fetch-gtfs.js (no download)
 *   - Output: outputs/<feedId>.sqlite3.gz (raw .sqlite3 transient)
 *   - No manifest written — feeds.json carries all the metadata
 *
 * Returns: { localPath, sizeBytes } for the .sqlite3.gz file.
 */

import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import StreamZip from 'node-stream-zip';

import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';import { createHash } from 'node:crypto';

import { resolveRouteColors } from './lib/route-colors.js';
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
  stop_times: {
    file: 'stop_times.txt',
    columns: [
      ['trip_id', 'TEXT'],
      ['arrival_time', 'TEXT'],
      ['departure_time', 'TEXT'],
      ['stop_id', 'TEXT'],
      ['stop_sequence', 'INTEGER'],
      ['pickup_type', 'INTEGER'],
      ['drop_off_type', 'INTEGER'],
      ['shape_dist_traveled', 'REAL'],
    ],
    indexes: [
      ['stop_times_trip_seq_idx', '(trip_id, stop_sequence)'],
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

async function readCsvFromZip(zip, filename) {
  try {
    const buf = await zip.entryData(filename);
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    return parse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      trim: true,
    });
  } catch {
    return null;
  }
}

function createSchema(db) {
  for (const [tableName, spec] of Object.entries(SCHEMA)) {
    const cols = spec.columns.map(([n, t]) => `${n} ${t}`).join(', ');
    db.exec(`CREATE TABLE ${tableName} (${cols});`);
    for (const [idxName, idxCols] of spec.indexes ?? []) {
      db.exec(`CREATE INDEX ${idxName} ON ${tableName} ${idxCols};`);
    }
  }
  db.pragma('page_size = 4096');
}

function insertRows(db, tableName, columns, rows) {
  if (!rows || rows.length === 0) return 0;
  const colNames = columns.map(([n]) => n);
  const placeholders = colNames.map(() => '?').join(', ');
  // OR IGNORE: external feeds occasionally violate PK uniqueness (duplicate
  // stop_id rows for parent stations etc.); we drop dupes rather than error.
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${tableName} (${colNames.join(', ')}) VALUES (${placeholders})`);
  const txn = db.transaction((all) => {
    for (const row of all) {
      const values = colNames.map((c) => {
        const v = row[c];
        return v === undefined || v === '' ? null : v;
      });
      stmt.run(values);
    }
  });
  txn(rows);
  return rows.length;
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

  try {
    createSchema(db);
    const stats = {};
    for (const [tableName, spec] of Object.entries(SCHEMA)) {
      let rows = await readCsvFromZip(zip, spec.file);
      if (!rows) continue;
      // Apply the route-color quirk fixer to routes.txt rows. Feeds
      // already curated upstream (e.g. Cluj after its adapter) emit
      // "no route_color fixes needed"; feeds with placeholders or
      // cross-type modal collisions get substituted + skewed per
      // src/pipeline/lib/route-colors.js.
      if (tableName === 'routes') {
        const result = resolveRouteColors(rows);
        rows = result.rows;
        for (const line of result.logs) {
          console.log(`[make-sqlite] ${feedId}: routes — ${line}`);
        }
      }
      const n = insertRows(db, tableName, spec.columns, rows);
      stats[tableName] = n;
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

  console.log(`[make-sqlite] ${feedId}: raw=${(rawSize / 1024).toFixed(1)}KB gz=${(sizeBytes / 1024).toFixed(1)}KB (${((sizeBytes / rawSize) * 100).toFixed(0)}%)`);
  return { localPath: gzPath, sizeBytes, hash };
}
