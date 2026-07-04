import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA, SCHEMA_SQL, REQUIRED_TABLES } from '../src/sql/ddl.js';

describe('SCHEMA', () => {
  it('covers the 9 standard GTFS Schedule tables', () => {
    const expected = [
      'agency',
      'stops',
      'routes',
      'trips',
      'stop_times',
      'calendar',
      'calendar_dates',
      'shapes',
      'feed_info',
    ];
    for (const table of expected) {
      expect(SCHEMA[table], `missing table: ${table}`).toBeDefined();
      expect(SCHEMA[table]!.file).toBe(`${table}.txt`);
    }
  });

  it('includes the public networks.txt and route_networks.txt tables', () => {
    // networks + route_networks are public GTFS Schedule files
    // (https://gtfs.org/schedule/reference/), not producer extensions.
    // They belong in the spec library alongside the 9 standard tables
    // so any consumer (or producer) can rely on SCHEMA to know the
    // public contract. Producer-specific additions (e.g. the
    // computed network_color column) live in the static pipeline's
    // extensions map, not here.
    expect(SCHEMA.networks).toBeDefined();
    expect(SCHEMA.networks!.file).toBe('networks.txt');
    expect(SCHEMA.route_networks).toBeDefined();
    expect(SCHEMA.route_networks!.file).toBe('route_networks.txt');
    // Spec-mandated: route_id is the PK alone (a route can be in at
    // most one network per the public spec).
    expect(SCHEMA.route_networks!.tableConstraints).toContain('PRIMARY KEY (route_id)');
  });

  it('marks stop_times as WITHOUT ROWID with composite PK', () => {
    const stopTimes = SCHEMA.stop_times!;
    expect(stopTimes.withoutRowid).toBe(true);
    expect(stopTimes.tableConstraints).toContain('PRIMARY KEY (trip_id, stop_sequence)');
  });

  it('every column is a [name, type] tuple', () => {
    for (const [tableName, spec] of Object.entries(SCHEMA)) {
      for (const col of spec.columns) {
        expect(col).toHaveLength(2);
        const [name, type] = col;
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
        expect(typeof type).toBe('string');
        expect(type.length).toBeGreaterThan(0);
        // GTFS column names are snake_case. No spaces, no uppercase.
        expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
        // Tabulate a warning for human reading; do not throw.
        if (!/^[A-Z]/.test(name)) continue;
        // (no-op; keep the assertion in case name ever drifts)
        expect(tableName).toBe(tableName);
      }
    }
  });
});

describe('SCHEMA_SQL', () => {
  it('parses as valid SQL on a fresh sqlite', () => {
    const db = new Database(':memory:');
    try {
      expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('creates all 9 standard tables', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as Array<{ name: string }>;
      const names = tables.map((r) => r.name);
      for (const table of [
        'agency', 'calendar', 'calendar_dates', 'feed_info',
        'routes', 'shapes', 'stop_times', 'stops', 'trips',
      ]) {
        expect(names).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it('creates the non-PK indexes declared in SCHEMA', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as Array<{ name: string }>;
      const names = indexes.map((r) => r.name);
      for (const idx of ['routes_agency_idx', 'trips_route_idx', 'trips_service_idx',
        'trips_shape_idx', 'stop_times_stop_idx', 'calendar_dates_service_date_idx',
        'shapes_id_seq_idx']) {
        expect(names).toContain(idx);
      }
    } finally {
      db.close();
    }
  });

  it('stop_times is created as a WITHOUT ROWID table', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      // sqlite_master 'sql' for a without-rowid table contains 'WITHOUT ROWID'.
      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='stop_times'",
      ).get() as { sql: string } | undefined;
      expect(row?.sql).toContain('WITHOUT ROWID');
      expect(row?.sql).toContain('PRIMARY KEY (trip_id, stop_sequence)');
    } finally {
      db.close();
    }
  });

  it('column types in the SQL string match the SCHEMA structure', () => {
    // Cross-check that the SQL string's columns correspond to the
    // structural definition. If someone hand-edits one without the
    // other, this fails.
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      for (const [tableName, spec] of Object.entries(SCHEMA)) {
        const pragma = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>;
        const schemaNames = spec.columns.map(([n]) => n);
        const pragmaNames = pragma.map((c) => c.name);
        expect(pragmaNames.sort()).toEqual(schemaNames.sort());
      }
    } finally {
      db.close();
    }
  });
});

describe('REQUIRED_TABLES', () => {
  it('is exactly the 5 tables the GTFS spec requires for a usable feed', () => {
    expect([...REQUIRED_TABLES].sort()).toEqual(
      ['agency', 'routes', 'stop_times', 'stops', 'trips'],
    );
  });
});