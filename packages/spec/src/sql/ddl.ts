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
 * Per-column and table-level CHECK constraints ARE declared here, as
 * well as FOREIGN KEY constraints to enforce referential integrity at
 * INSERT time. Both are opt-in for consumers via `PRAGMA foreign_keys
 * = ON;` — without that pragma, SQLite parses but doesn't enforce
 * FK constraints. (CHECK constraints are always enforced regardless
 * of the pragma.) See make-sqlite.ts in gtfs-static for the
 * canonical "opt-in" pattern.
 *
 * Why constraints live here, not in the consumer:
 *   - Single source of truth for both the column shape AND the
 *     per-row invariants the GTFS spec describes. If the spec adds
 *     a new range or enum, the constraint ships with the column.
 *   - Browser-side GTFS workers (the @n3ary/app GTFS worker) get the
 *     same invariants enforced for free, not just the Node pipeline.
 *   - Bad adapter output fails at INSERT time with a clear SQLite
 *     error message naming the violated constraint — much easier to
 *     debug than discovering the bad row in feeds.json after a 7-minute
 *     daily cron run.
 *
 * FK caveats:
 *   - `trips.service_id` is intentionally NOT a FK because the value
 *     can reference either `calendar.service_id` or
 *     `calendar_dates.service_id` (GTFS allows both). A polymorphic
 *     FK isn't expressible in SQLite; we rely on the
 *     `validate.ts`-level cross-reference check (Layer 1) to catch
 *     orphans.
 *   - `stops.parent_station` is a self-reference; SQLite allows
 *     deferred FK check on this, but better-sqlite3 with the default
 *     `foreign_keys = ON` checks at INSERT time. We use NO ACTION
 *     (the default) which surfaces the violation immediately.
 */

/** A single SQLite column declaration: [name, sqlType, check?] */
export type ColumnSpec = [name: string, type: string, check?: string];

/** A foreign-key declaration. */
export type ForeignKeySpec = {
  /** Column(s) on this table that hold the FK. */
  columns: string[];
  /** Referenced table name (must exist in SCHEMA). */
  refTable: string;
  /** Column(s) on the referenced table. */
  refColumns: string[];
  /** Optional ON DELETE action (default = NO ACTION). */
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
};

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
  /** Foreign-key declarations. */
  foreignKeys?: ForeignKeySpec[];
};

/**
 * All 11 standard GTFS Schedule tables.
 *
 * IMPORTANT — declaration order = FK load order. With `PRAGMA
 * foreign_keys = ON`, SQLite checks each row's FKs at INSERT time,
 * so a referenced row must exist before any referencing row is
 * inserted. The current order is dependency-first:
 *
 *   1. agency         (no deps)
 *   2. stops          (self-ref parent_station, deferred)
 *   3. routes         (FK → agency)
 *   4. trips          (FK → routes; service_id NOT FK'd — see header)
 *   5. stop_times     (FK → trips, stops; composite PK)
 *   6. calendar       (no deps)
 *   7. calendar_dates (FK → calendar)
 *   8. shapes         (no deps)
 *   9. feed_info      (no deps)
 *  10. networks       (no deps)
 *  11. route_networks (FK → networks, routes)
 *
 * Do not reorder without checking that the new order still satisfies
 * FKs.
 */
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
      ['stop_lat', 'REAL',
        'CHECK(stop_lat IS NULL OR (stop_lat >= -90 AND stop_lat <= 90))'],
      // Conditionally required. WGS84 lon, -180..180.
      ['stop_lon', 'REAL',
        'CHECK(stop_lon IS NULL OR (stop_lon >= -180 AND stop_lon <= 180))'],
      // Optional. 0=stop/platform (default), 1=station, 2=entrance,
      // 3=generic node, 4=boarding area.
      ['location_type', 'INTEGER',
        'CHECK(location_type IS NULL OR (location_type >= 0 AND location_type <= 4))'],
      // Conditionally required. Foreign ID → stops.stop_id (self).
      ['parent_station', 'TEXT'],
      // Optional. Inherits from parent station or agency.
      ['stop_timezone', 'TEXT'],
      // Optional. 0=unknown (default), 1=accessible, 2=not.
      ['wheelchair_boarding', 'INTEGER',
        'CHECK(wheelchair_boarding IS NULL OR (wheelchair_boarding >= 0 AND wheelchair_boarding <= 2))'],
      // Optional. Foreign ID → levels.level_id.
      ['level_id', 'TEXT'],
      // Optional. Platform identifier only ("G", "3"); no "platform" word.
      ['platform_code', 'TEXT'],
    ],
    foreignKeys: [
      // Self-reference: parent_station → stops.stop_id. NO ACTION so
      // a delete that would orphan a child fails loudly rather than
      // cascading through the tree.
      { columns: ['parent_station'], refTable: 'stops', refColumns: ['stop_id'] },
    ],
    // Table-level: when location_type ∈ {0,1,2} (i.e. a stop/station/
    // entrance), GTFS requires stop_name + lat/lon. The "entrances
    // without name" loophole was closed in GTFS spec 2.0+.
    tableConstraints: [
      'CHECK(' +
        '(location_type IS NULL OR location_type BETWEEN 0 AND 2) ' +
        'OR (stop_name IS NOT NULL AND stop_lat IS NOT NULL AND stop_lon IS NOT NULL)' +
      ')',
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
      // 6=aerial, 7=funicular, 11=trolleybus, 12=monorail. Spec allows
      // extended values >=100 for non-standard types, hence range.
      ['route_type', 'INTEGER NOT NULL',
        'CHECK(route_type >= 0)'],
      // Optional. URL.
      ['route_url', 'TEXT'],
      // Optional. 6-digit hex without #.
      ['route_color', 'TEXT',
        'CHECK(route_color IS NULL OR length(route_color) = 6)'],
      // Optional. 6-digit hex without #.
      ['route_text_color', 'TEXT',
        'CHECK(route_text_color IS NULL OR length(route_text_color) = 6)'],
      // Optional. Sort order.
      ['route_sort_order', 'INTEGER'],
      // Optional / conditionally forbidden. 0..3.
      ['continuous_pickup', 'INTEGER',
        'CHECK(continuous_pickup IS NULL OR (continuous_pickup >= 0 AND continuous_pickup <= 3))'],
      // Optional / conditionally forbidden. 0..3.
      ['continuous_drop_off', 'INTEGER',
        'CHECK(continuous_drop_off IS NULL OR (continuous_drop_off >= 0 AND continuous_drop_off <= 3))'],
      // Optional / conditionally forbidden (forbidden if networks.txt exists).
      ['network_id', 'TEXT'],
    ],
    foreignKeys: [
      { columns: ['agency_id'], refTable: 'agency', refColumns: ['agency_id'] },
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
      // NOT FK'd (see header comment) — orphan-service is caught by
      // validate.ts (Layer 1 cross-reference check).
      ['service_id', 'TEXT NOT NULL'],
      // Optional. Destination visible to riders.
      ['trip_headsign', 'TEXT'],
      // Optional. Sub-name within a service day.
      ['trip_short_name', 'TEXT'],
      // Optional. 0 or 1.
      ['direction_id', 'INTEGER',
        'CHECK(direction_id IS NULL OR (direction_id >= 0 AND direction_id <= 1))'],
      // Optional. Sequential trip chaining.
      ['block_id', 'TEXT'],
      // Conditionally required. Foreign ID → shapes.shape_id.
      ['shape_id', 'TEXT'],
      // Optional. 0/1/2.
      ['wheelchair_accessible', 'INTEGER',
        'CHECK(wheelchair_accessible IS NULL OR (wheelchair_accessible >= 0 AND wheelchair_accessible <= 2))'],
      // Optional. 0/1/2.
      ['bikes_allowed', 'INTEGER',
        'CHECK(bikes_allowed IS NULL OR (bikes_allowed >= 0 AND bikes_allowed <= 2))'],
      // Optional. 0/1/2.
      ['cars_allowed', 'INTEGER',
        'CHECK(cars_allowed IS NULL OR (cars_allowed >= 0 AND cars_allowed <= 2))'],
    ],
    foreignKeys: [
      { columns: ['route_id'], refTable: 'routes', refColumns: ['route_id'] },
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
  //   * The composite PK constraint enforces dedupe. A real GTFS feed
  //     should never duplicate (trip_id, stop_sequence) — if it does,
  //     the inserter fails loud (per the "hard fail" mode).
  stop_times: {
    file: 'stop_times.txt',
    columns: [
      // Required. Foreign ID → trips.trip_id.
      ['trip_id', 'TEXT NOT NULL'],
      // Conditionally required per GTFS spec — required for the first and
      // last stops of a trip, otherwise optional. Real feeds leave it
      // blank for intermediate stops; making it NOT NULL would reject
      // every such row.
      ['arrival_time', 'TEXT',
        // Accepts HH:MM:SS where H can be 2+ digits (24:00:00+ allowed
        // per spec for service crossing midnight). Glob matches one or
        // more leading digits.
        "CHECK(arrival_time IS NULL OR arrival_time GLOB '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' OR arrival_time GLOB '[0-9][0-9][0-9]:[0-9][0-9]:[0-9][0-9]')"],
      // Same: conditionally required.
      ['departure_time', 'TEXT',
        "CHECK(departure_time IS NULL OR departure_time GLOB '[0-9][0-9]:[0-9][0-9]:[0-9][0-9]' OR departure_time GLOB '[0-9][0-9][0-9]:[0-9][0-9]:[0-9][0-9]')"],
      // Required. Foreign ID → stops.stop_id.
      ['stop_id', 'TEXT NOT NULL'],
      // Required. Monotonically increasing per trip. GTFS spec says
      // "non-negative integer" — feeds in the wild include 0
      // (Transitous uses it for the origin stop). >0 was too strict;
      // use >=0 to match the spec.
      ['stop_sequence', 'INTEGER NOT NULL',
        'CHECK(stop_sequence >= 0)'],
      // Optional. Overrides trips.trip_headsign.
      ['stop_headsign', 'TEXT'],
      // Optional / conditionally forbidden. 0..3.
      ['pickup_type', 'INTEGER',
        'CHECK(pickup_type IS NULL OR (pickup_type >= 0 AND pickup_type <= 3))'],
      // Optional / conditionally forbidden. 0..3.
      ['drop_off_type', 'INTEGER',
        'CHECK(drop_off_type IS NULL OR (drop_off_type >= 0 AND drop_off_type <= 3))'],
      // Optional / conditionally forbidden.
      ['continuous_pickup', 'INTEGER',
        'CHECK(continuous_pickup IS NULL OR (continuous_pickup >= 0 AND continuous_pickup <= 3))'],
      // Optional / conditionally forbidden.
      ['continuous_drop_off', 'INTEGER',
        'CHECK(continuous_drop_off IS NULL OR (continuous_drop_off >= 0 AND continuous_drop_off <= 3))'],
      // Optional. Non-negative float; units must match shapes.txt.
      ['shape_dist_traveled', 'REAL',
        'CHECK(shape_dist_traveled IS NULL OR shape_dist_traveled >= 0)'],
      // Optional. 0=approximate, 1=exact.
      ['timepoint', 'INTEGER',
        'CHECK(timepoint IS NULL OR (timepoint >= 0 AND timepoint <= 1))'],
    ],
    tableConstraints: [
      'PRIMARY KEY (trip_id, stop_sequence)',
      // Cross-column: departure can't be earlier than arrival. TEXT
      // comparison works because HH:MM:SS is zero-padded + fixed-width
      // (or 3-digit hours for service crossing midnight, also sorted
      // correctly by lexicographic order).
      'CHECK(arrival_time <= departure_time)',
    ],
    withoutRowid: true,
    foreignKeys: [
      { columns: ['trip_id'], refTable: 'trips', refColumns: ['trip_id'] },
      { columns: ['stop_id'], refTable: 'stops', refColumns: ['stop_id'] },
    ],
    indexes: [['stop_times_stop_idx', '(stop_id)']],
  },
  calendar: {
    file: 'calendar.txt',
    columns: [
      // Required. Unique across the feed.
      ['service_id', 'TEXT PRIMARY KEY'],
      // Required. GTFS spec: 0 or 1 (no other values).
      ['monday', 'INTEGER NOT NULL', 'CHECK(monday IN (0, 1))'],
      ['tuesday', 'INTEGER NOT NULL', 'CHECK(tuesday IN (0, 1))'],
      ['wednesday', 'INTEGER NOT NULL', 'CHECK(wednesday IN (0, 1))'],
      ['thursday', 'INTEGER NOT NULL', 'CHECK(thursday IN (0, 1))'],
      ['friday', 'INTEGER NOT NULL', 'CHECK(friday IN (0, 1))'],
      ['saturday', 'INTEGER NOT NULL', 'CHECK(saturday IN (0, 1))'],
      ['sunday', 'INTEGER NOT NULL', 'CHECK(sunday IN (0, 1))'],
      // Required. YYYYMMDD format.
      ['start_date', 'TEXT NOT NULL',
        "CHECK(start_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')"],
      // Required. YYYYMMDD format.
      ['end_date', 'TEXT NOT NULL',
        "CHECK(end_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')"],
    ],
    tableConstraints: ['CHECK(start_date <= end_date)'],
  },
  calendar_dates: {
    file: 'calendar_dates.txt',
    columns: [
      // Required. Foreign ID → calendar.service_id (or self-key if calendar.txt absent).
      ['service_id', 'TEXT NOT NULL'],
      // Required. YYYYMMDD format.
      ['date', 'TEXT NOT NULL',
        "CHECK(date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')"],
      // Required. 1=service added, 2=service removed.
      ['exception_type', 'INTEGER NOT NULL',
        'CHECK(exception_type IN (1, 2))'],
    ],
    foreignKeys: [
      { columns: ['service_id'], refTable: 'calendar', refColumns: ['service_id'] },
    ],
    indexes: [['calendar_dates_service_date_idx', '(service_id, date)']],
  },
  shapes: {
    file: 'shapes.txt',
    columns: [
      // Required.
      ['shape_id', 'TEXT NOT NULL'],
      // Required. -90..90.
      ['shape_pt_lat', 'REAL NOT NULL',
        'CHECK(shape_pt_lat >= -90 AND shape_pt_lat <= 90)'],
      // Required. -180..180.
      ['shape_pt_lon', 'REAL NOT NULL',
        'CHECK(shape_pt_lon >= -180 AND shape_pt_lon <= 180)'],
      // Required. Monotonically increasing per shape_id. GTFS spec:
      // non-negative integer. Some real feeds (e.g. Transitous) use
      // 0 for the origin point.
      ['shape_pt_sequence', 'INTEGER NOT NULL',
        'CHECK(shape_pt_sequence >= 0)'],
      // Optional. Non-negative float; units must match stop_times.
      ['shape_dist_traveled', 'REAL',
        'CHECK(shape_dist_traveled IS NULL OR shape_dist_traveled >= 0)'],
    ],
    // Composite uniqueness on (shape_id, shape_pt_sequence) — a shape
    // point should never have two entries at the same sequence.
    tableConstraints: ['UNIQUE(shape_id, shape_pt_sequence)'],
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
      ['feed_start_date', 'TEXT',
        "CHECK(feed_start_date IS NULL OR feed_start_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')"],
      // Recommended. YYYYMMDD.
      ['feed_end_date', 'TEXT',
        "CHECK(feed_end_date IS NULL OR feed_end_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')"],
      // Recommended. Dataset version string.
      ['feed_version', 'TEXT'],
      // Optional. Technical contact email.
      ['feed_contact_email', 'TEXT'],
      // Optional. Technical contact URL.
      ['feed_contact_url', 'TEXT'],
    ],
    tableConstraints: [
      'CHECK(feed_start_date IS NULL OR feed_end_date IS NULL OR feed_start_date <= feed_end_date)',
    ],
  },
  // networks.txt — Conditionally Forbidden. When present, defines
  // network identifiers that apply for fare leg rules. A route can
  // belong to at most one network (PK is `route_id` on
  // route_networks.txt). See
  // https://gtfs.org/documentation/schedule/reference/#networkstxt
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
  // primary key alone (a route can be in at most one network). A
  // 1:many feed-quirk row beyond the first will fail the composite PK
  // INSERT — that's intentional, it's a contract violation.
  route_networks: {
    file: 'route_networks.txt',
    columns: [
      // Foreign ID → networks.network_id. Required.
      ['network_id', 'TEXT NOT NULL'],
      // Foreign ID → routes.route_id. Required. Also the table's PK.
      ['route_id', 'TEXT NOT NULL'],
    ],
    tableConstraints: ['PRIMARY KEY (route_id)'],
    foreignKeys: [
      { columns: ['network_id'], refTable: 'networks', refColumns: ['network_id'] },
      { columns: ['route_id'], refTable: 'routes', refColumns: ['route_id'] },
    ],
    indexes: [['route_networks_network_idx', '(network_id)']],
  },
};

/** Tables that must be present and non-empty for a usable GTFS feed. */
export const REQUIRED_TABLES = ['agency', 'stops', 'routes', 'trips', 'stop_times'] as const;

/**
 * Render a single ForeignKeySpec as the SQLite FOREIGN KEY clause.
 */
function fkClause(fk: ForeignKeySpec): string {
  const cols = fk.columns.join(', ');
  const refCols = fk.refColumns.join(', ');
  const onDel = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '';
  return `FOREIGN KEY (${cols}) REFERENCES ${fk.refTable}(${refCols})${onDel}`;
}

/**
 * The same DDL as {@link SCHEMA}, serialized into a single SQL string
 * the consumer can pass to `db.exec(...)`. Indexes are inline after
 * their parent table; FK declarations are folded into CREATE TABLE.
 *
 * Generated programmatically from SCHEMA so the two cannot drift.
 */
export const SCHEMA_SQL: string = (() => {
  const stmts: string[] = [];
  for (const [tableName, spec] of Object.entries(SCHEMA)) {
    // Columns: name TYPE [CHECK(...)]
    const colDefs = spec.columns.map(([n, t, check]) => {
      const base = `${n} ${t}`;
      return check ? `${base} ${check}` : base;
    });
    // Table-level: PRIMARY KEY / UNIQUE / generic CHECK
    const tblConstraints = spec.tableConstraints ?? [];
    // FKs: collected at the table level (SQLite syntax: FOREIGN KEY
    // ... REFERENCES ... can appear in the column list OR as a
    // table-level constraint; we put them at table level for readability)
    const fks = (spec.foreignKeys ?? []).map(fkClause);
    const body = [...colDefs, ...tblConstraints, ...fks].join(', ');
    const opts = spec.withoutRowid ? ' WITHOUT ROWID' : '';
    stmts.push(`CREATE TABLE ${tableName} (${body})${opts};`);
    for (const [idxName, idxCols] of spec.indexes ?? []) {
      stmts.push(`CREATE INDEX ${idxName} ON ${tableName} ${idxCols};`);
    }
  }
  return stmts.join('\n');
})();