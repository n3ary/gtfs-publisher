/**
 * Canonical GTFS Schedule SQLite DDL.
 *
 * One CREATE TABLE per spec file in the GTFS Schedule reference
 * (https://gtfs.org/documentation/schedule/reference/), plus the
 * indexes our consumers rely on. Browser-compatible — this file does
 * NOT import `better-sqlite3` (or any other native driver). Consumers
 * apply the DDL with their preferred driver:
 *
 *   import Database from 'better-sqlite3';            // Node
 *   const db = new Database(':memory:');
 *   db.exec(SCHEMA_SQL);
 *
 *   import sqlite3InitModule from '@sqlite.org/sqlite-wasm';  // browser
 *   const db = new sqlite3.oo1.DB(':memory:');
 *   db.exec(SCHEMA_SQL);
 *
 * The two consumers in this monorepo (gtfs-static for offline builds,
 * gtfs-rt for live RT) share the DDL via the `SCHEMA` object — that's
 * why the same table shapes are described structurally, not just as
 * a SQL string.
 *
 * Per-feed extensions (the producer-computed `network_color` column
 * and the `_neary_config` metadata table) are NOT included here.
 * They're pipeline-specific and live in
 * packages/gtfs-static/src/extensions.ts.
 *
 * No SQLite-level foreign keys are declared. Consumers can opt in via
 * `PRAGMA foreign_keys = ON;` if they want referential integrity
 * enforced.
 */

/** A single SQLite column declaration: [name, sqlType]. */
export type ColumnSpec = [name: string, type: string];

/** A single GTFS table definition. */
export type SchemaSpec = {
  /** The source CSV filename inside the GTFS .zip (e.g. 'agency.txt'). */
  file: string;
  /** Columns in declaration order. */
  columns: ColumnSpec[];
  /** Optional table-level constraints (e.g. composite PK for stop_times). */
  tableConstraints?: string[];
  /** Set true for stop_times — composite PK becomes the rowid. */
  withoutRowid?: boolean;
  /** Non-PK indexes to add after CREATE TABLE. */
  indexes?: Array<[name: string, cols: string]>;
};

/** All 9 standard GTFS Schedule tables. */
export const SCHEMA: Record<string, SchemaSpec> = {
  agency: {
    file: 'agency.txt',
    columns: [
      // Conditionally required (required if more than one row in agency.txt).
      // Internal feed-unique identifier. Stored as TEXT — GTFS doesn't
      // restrict to integer IDs.
      ['agency_id', 'TEXT PRIMARY KEY'],
      // Required. Full name.
      ['agency_name', 'TEXT NOT NULL'],
      // Required. Fully qualified URL.
      ['agency_url', 'TEXT NOT NULL'],
      // Required. IANA timezone.
      ['agency_timezone', 'TEXT NOT NULL'],
      // Optional. IETF BCP 47 language code.
      ['agency_lang', 'TEXT'],
      // Optional. Phone number string.
      ['agency_phone', 'TEXT'],
      // Optional. Fully qualified fare-URL.
      ['agency_fare_url', 'TEXT'],
      // Optional. Customer-service email.
      ['agency_email', 'TEXT'],
    ],
  },
  stops: {
    file: 'stops.txt',
    columns: [
      // Required. Unique across stops, locations.geojson, and
      // location_groups.location_group_id values.
      ['stop_id', 'TEXT PRIMARY KEY'],
      // Optional. Short code visible to riders.
      ['stop_code', 'TEXT'],
      // Conditionally required (required if location_type ∈ {0,1,2}).
      ['stop_name', 'TEXT'],
      // Conditionally required. WGS84 lat, -90..90.
      ['stop_lat', 'REAL'],
      // Conditionally required. WGS84 lon, -180..180.
      ['stop_lon', 'REAL'],
      // Optional. 0=stop/platform (default), 1=station, 2=entrance,
      // 3=generic node, 4=boarding area.
      ['location_type', 'INTEGER'],
      // Conditionally required. Foreign ID → stops.stop_id.
      ['parent_station', 'TEXT'],
      // Optional. Inherits from parent station or agency.
      ['stop_timezone', 'TEXT'],
      // Optional. 0=unknown (default), 1=accessible, 2=not.
      ['wheelchair_boarding', 'INTEGER'],
      // Optional. Foreign ID → levels.level_id.
      ['level_id', 'TEXT'],
      // Optional. Platform identifier only ("G", "3"); no "platform" word.
      ['platform_code', 'TEXT'],
    ],
  },
  routes: {
    file: 'routes.txt',
    columns: [
      // Required. Internal feed-unique identifier.
      ['route_id', 'TEXT PRIMARY KEY'],
      // Conditionally required (required if more than one agency in agency.txt).
      // Foreign ID → agency.agency_id.
      ['agency_id', 'TEXT'],
      // Conditionally required. Short name.
      ['route_short_name', 'TEXT'],
      // Conditionally required. Long name.
      ['route_long_name', 'TEXT'],
      // Optional. Should not duplicate short/long name.
      ['route_desc', 'TEXT'],
      // Required. 0=tram, 1=subway, 2=rail, 3=bus, 4=ferry, 5=cable tram,
      // 6=aerial, 7=funicular, 11=trolleybus, 12=monorail.
      ['route_type', 'INTEGER NOT NULL'],
      // Optional. URL.
      ['route_url', 'TEXT'],
      // Optional. 6-digit hex without #.
      ['route_color', 'TEXT'],
      // Optional. 6-digit hex without #.
      ['route_text_color', 'TEXT'],
      // Optional. Sort order.
      ['route_sort_order', 'INTEGER'],
      // Optional / conditionally forbidden. 0,1,2,3.
      ['continuous_pickup', 'INTEGER'],
      // Optional / conditionally forbidden. 0,1,2,3.
      ['continuous_drop_off', 'INTEGER'],
      // Optional / conditionally forbidden (forbidden if networks.txt exists).
      ['network_id', 'TEXT'],
    ],
    indexes: [['routes_agency_idx', '(agency_id)']],
  },
  trips: {
    file: 'trips.txt',
    columns: [
      // Required. Internal feed-unique identifier.
      ['trip_id', 'TEXT PRIMARY KEY'],
      // Conditionally required (required if more than one route).
      // Foreign ID → routes.route_id.
      ['route_id', 'TEXT'],
      // Required. Foreign ID → calendar.service_id or calendar_dates.service_id.
      ['service_id', 'TEXT NOT NULL'],
      // Optional. Destination visible to riders.
      ['trip_headsign', 'TEXT'],
      // Optional. Sub-name within a service day.
      ['trip_short_name', 'TEXT'],
      // Optional. 0 or 1.
      ['direction_id', 'INTEGER'],
      // Optional. Sequential trip chaining.
      ['block_id', 'TEXT'],
      // Conditionally required. Foreign ID → shapes.shape_id.
      ['shape_id', 'TEXT'],
      // Optional. 0/1/2.
      ['wheelchair_accessible', 'INTEGER'],
      // Optional. 0/1/2.
      ['bikes_allowed', 'INTEGER'],
      // Optional. 0/1/2.
      ['cars_allowed', 'INTEGER'],
    ],
    indexes: [
      ['trips_route_idx', '(route_id)'],
      ['trips_service_idx', '(service_id)'],
      ['trips_shape_idx', '(shape_id)'],
    ],
  },
  // stop_times is 60-90% of a national GTFS sqlite by size. Two knobs:
  //   * Composite PK (trip_id, stop_sequence) is already the natural
  //     key, so we can make the primary-key B-tree BE the table via
  //     WITHOUT ROWID. Drops the implicit rowid column and folds the
  //     previous (trip_id, stop_sequence) index into the primary
  //     store — one less full-table B-tree on disk.
  //   * The composite PK constraint enforces dedupe; consumers should
  //     use INSERT OR IGNORE to handle malformed feeds that violate
  //     the natural key (handled by the static pipeline's inserter).
  stop_times: {
    file: 'stop_times.txt',
    columns: [
      // Required. Foreign ID → trips.trip_id.
      ['trip_id', 'TEXT NOT NULL'],
      // Conditionally required. HH:MM:SS; >24:00:00 allowed.
      ['arrival_time', 'TEXT'],
      // Conditionally required. HH:MM:SS.
      ['departure_time', 'TEXT'],
      // Conditionally required. Foreign ID → stops.stop_id.
      ['stop_id', 'TEXT'],
      // Required. Monotonically increasing per trip.
      ['stop_sequence', 'INTEGER NOT NULL'],
      // Optional. Overrides trips.trip_headsign.
      ['stop_headsign', 'TEXT'],
      // Optional / conditionally forbidden. 0..3.
      ['pickup_type', 'INTEGER'],
      // Optional / conditionally forbidden. 0..3.
      ['drop_off_type', 'INTEGER'],
      // Optional / conditionally forbidden.
      ['continuous_pickup', 'INTEGER'],
      // Optional / conditionally forbidden.
      ['continuous_drop_off', 'INTEGER'],
      // Optional. Non-negative float; units must match shapes.txt.
      ['shape_dist_traveled', 'REAL'],
      // Optional. 0=approximate, 1=exact.
      ['timepoint', 'INTEGER'],
    ],
    tableConstraints: ['PRIMARY KEY (trip_id, stop_sequence)'],
    withoutRowid: true,
    indexes: [['stop_times_stop_idx', '(stop_id)']],
  },
  calendar: {
    file: 'calendar.txt',
    columns: [
      // Required. Unique across the feed.
      ['service_id', 'TEXT PRIMARY KEY'],
      ['monday', 'INTEGER NOT NULL'],
      ['tuesday', 'INTEGER NOT NULL'],
      ['wednesday', 'INTEGER NOT NULL'],
      ['thursday', 'INTEGER NOT NULL'],
      ['friday', 'INTEGER NOT NULL'],
      ['saturday', 'INTEGER NOT NULL'],
      ['sunday', 'INTEGER NOT NULL'],
      // Required. YYYYMMDD.
      ['start_date', 'TEXT NOT NULL'],
      // Required. YYYYMMDD.
      ['end_date', 'TEXT NOT NULL'],
    ],
  },
  calendar_dates: {
    file: 'calendar_dates.txt',
    columns: [
      // Required. Foreign ID → calendar.service_id (or self-key if calendar.txt absent).
      ['service_id', 'TEXT NOT NULL'],
      // Required. YYYYMMDD.
      ['date', 'TEXT NOT NULL'],
      // Required. 1=service added, 2=service removed.
      ['exception_type', 'INTEGER NOT NULL'],
    ],
    indexes: [['calendar_dates_service_date_idx', '(service_id, date)']],
  },
  shapes: {
    file: 'shapes.txt',
    columns: [
      // Required.
      ['shape_id', 'TEXT NOT NULL'],
      // Required. -90..90.
      ['shape_pt_lat', 'REAL NOT NULL'],
      // Required. -180..180.
      ['shape_pt_lon', 'REAL NOT NULL'],
      // Required. Monotonically increasing per shape_id.
      ['shape_pt_sequence', 'INTEGER NOT NULL'],
      // Optional. Non-negative float; units must match stop_times.
      ['shape_dist_traveled', 'REAL'],
    ],
    indexes: [['shapes_id_seq_idx', '(shape_id, shape_pt_sequence)']],
  },
  feed_info: {
    file: 'feed_info.txt',
    columns: [
      // Required. Full name of the publishing organization.
      ['feed_publisher_name', 'TEXT NOT NULL'],
      // Required. URL of the publisher's website.
      ['feed_publisher_url', 'TEXT NOT NULL'],
      // Required. IETF BCP 47; 'mul' allowed when translations.txt present.
      ['feed_lang', 'TEXT NOT NULL'],
      // Recommended. YYYYMMDD.
      ['feed_start_date', 'TEXT'],
      // Recommended. YYYYMMDD.
      ['feed_end_date', 'TEXT'],
      // Recommended. Dataset version string.
      ['feed_version', 'TEXT'],
      // Optional. Technical contact email.
      ['feed_contact_email', 'TEXT'],
      // Optional. Technical contact URL.
      ['feed_contact_url', 'TEXT'],
    ],
  },
  // networks.txt — Conditionally Forbidden. When present, defines
  // network identifiers that apply for fare leg rules. A route can
  // belong to at most one network (PK is `route_id` on
  // route_networks.txt). See
  // https://gtfs.org/schedule/reference/#networkstxt
  networks: {
    file: 'networks.txt',
    columns: [
      // Required. Unique ID. Must be unique in networks.txt.
      ['network_id', 'TEXT PRIMARY KEY'],
      // Optional. The name of the network as used by the local agency
      // and its riders.
      ['network_name', 'TEXT'],
    ],
  },
  // route_networks.txt — Conditionally Forbidden. Assigns routes from
  // routes.txt to networks. The public spec declares `route_id` as the
  // primary key alone (a route can be in at most one network), so
  // INSERT OR IGNORE on this table naturally drops feed-quirk 1:many
  // rows beyond the first. See
  // https://gtfs.org/schedule/reference/#route_networkstxt
  route_networks: {
    file: 'route_networks.txt',
    columns: [
      // Foreign ID → networks.network_id. Required.
      ['network_id', 'TEXT NOT NULL'],
      // Foreign ID → routes.route_id. Required. Also the table's PK.
      ['route_id', 'TEXT NOT NULL'],
    ],
    tableConstraints: ['PRIMARY KEY (route_id)'],
    indexes: [['route_networks_network_idx', '(network_id)']],
  },
};

/** Tables that must be present and non-empty for a usable GTFS feed. */
export const REQUIRED_TABLES = ['agency', 'stops', 'routes', 'trips', 'stop_times'] as const;

/**
 * The same DDL as {@link SCHEMA}, serialized into a single SQL string
 * the consumer can pass to `db.exec(...)`. Indexes are inline after
 * their parent table.
 *
 * Generated programmatically from SCHEMA so the two cannot drift.
 */
export const SCHEMA_SQL: string = (() => {
  const stmts: string[] = [];
  for (const [tableName, spec] of Object.entries(SCHEMA)) {
    const cols = spec.columns.map(([n, t]) => `${n} ${t}`).join(', ');
    const constraints = spec.tableConstraints ?? [];
    const body = [cols, ...constraints].join(', ');
    const opts = spec.withoutRowid ? ' WITHOUT ROWID' : '';
    stmts.push(`CREATE TABLE ${tableName} (${body})${opts};`);
    for (const [idxName, idxCols] of spec.indexes ?? []) {
      stmts.push(`CREATE INDEX ${idxName} ON ${tableName} ${idxCols};`);
    }
  }
  return stmts.join('\n');
})();