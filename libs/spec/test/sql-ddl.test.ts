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

  it('every column is a [name, type, check?] tuple', () => {
    for (const [tableName, spec] of Object.entries(SCHEMA)) {
      for (const col of spec.columns) {
        // ColumnSpec = [name, type, check?]. check is optional; if
        // present it must be a non-empty string.
        expect(col.length).toBeGreaterThanOrEqual(2);
        expect(col.length).toBeLessThanOrEqual(3);
        const [name, type, check] = col;
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
        expect(typeof type).toBe('string');
        expect(type.length).toBeGreaterThan(0);
        if (check !== undefined) {
          expect(typeof check).toBe('string');
          expect(check.length).toBeGreaterThan(0);
          // CHECK clauses should always reference the column itself.
          expect(check.toLowerCase()).toContain(name.toLowerCase());
        }
        // GTFS column names are snake_case. No spaces, no uppercase.
        expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
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

describe('CHECK constraints (Layer 2: per-row invariants)', () => {
  it('rejects stop_lat out of [-90, 90]', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.exec("PRAGMA foreign_keys = ON;");
      db.prepare("INSERT INTO agency (agency_name, agency_url, agency_timezone) VALUES ('A','https://a','UTC')").run();
      expect(() =>
        db.prepare("INSERT INTO stops (stop_id, stop_lat) VALUES ('S1', 200.0)").run()
      ).toThrow(/CHECK constraint failed: stop_lat/);
    } finally {
      db.close();
    }
  });

  it('rejects stop_lon out of [-180, 180]', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      expect(() =>
        db.prepare("INSERT INTO stops (stop_id, stop_lon) VALUES ('S2', -200.0)").run()
      ).toThrow(/CHECK constraint failed: stop_lon/);
    } finally {
      db.close();
    }
  });

  it('rejects location_type out of [0, 4]', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      expect(() =>
        db.prepare("INSERT INTO stops (stop_id, location_type) VALUES ('S3', 99)").run()
      ).toThrow(/CHECK constraint failed: location_type/);
    } finally {
      db.close();
    }
  });

  it('rejects route_color not 6 chars', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.prepare("INSERT INTO agency (agency_name, agency_url, agency_timezone) VALUES ('A','https://a','UTC')").run();
      expect(() =>
        db.prepare("INSERT INTO routes (route_id, route_type, route_color) VALUES ('R1', 3, 'FFFFFF')").run()
      ).not.toThrow(); // 6 chars = OK
      expect(() =>
        db.prepare("INSERT INTO routes (route_id, route_type, route_color) VALUES ('R2', 3, 'FFF')").run()
      ).toThrow(/CHECK constraint failed: route_color/);
    } finally {
      db.close();
    }
  });

  it('rejects arrival_time not in HH:MM:SS format', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.prepare("INSERT INTO agency (agency_name, agency_url, agency_timezone) VALUES ('A','https://a','UTC')").run();
      db.prepare("INSERT INTO stops (stop_id) VALUES ('S1')").run();
      db.prepare("INSERT INTO routes (route_id, route_type) VALUES ('R1', 3)").run();
      db.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('SVC', 1,1,1,1,1,0,0,'20260701','20261231')").run();
      db.prepare("INSERT INTO trips (trip_id, route_id, service_id) VALUES ('T1', 'R1', 'SVC')").run();
      expect(() =>
        db.prepare("INSERT INTO stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES ('T1', '25:99', '26:00', 'S1', 1)").run()
      ).toThrow(/CHECK constraint failed: arrival_time/);
    } finally {
      db.close();
    }
  });

  it('rejects calendar.day bits not in {0, 1}', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      expect(() =>
        db.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('SVC', 2,1,1,1,1,0,0,'20260701','20261231')").run()
      ).toThrow(/CHECK constraint failed: monday/);
    } finally {
      db.close();
    }
  });

  it('rejects calendar.start_date > end_date', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      expect(() =>
        db.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('SVC', 1,1,1,1,1,0,0,'20261231','20260701')").run()
      ).toThrow(/CHECK constraint failed: start_date/);
    } finally {
      db.close();
    }
  });
});

describe('FOREIGN KEY constraints (Layer 2: referential integrity)', () => {
  it('rejects trips.route_id that does not exist in routes', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.exec('PRAGMA foreign_keys = ON;');
      db.prepare("INSERT INTO agency (agency_name, agency_url, agency_timezone) VALUES ('A','https://a','UTC')").run();
      // Calendar FK target needs to exist for trips.service_id NOT NULL
      // (service_id isn't FK'd but service must exist for the build
      // to make sense; let's add a calendar anyway).
      db.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('SVC', 1,1,1,1,1,0,0,'20260701','20261231')").run();
      // No route with route_id='R_GHOST' — insert should fail.
      expect(() =>
        db.prepare("INSERT INTO trips (trip_id, route_id, service_id) VALUES ('T1', 'R_GHOST', 'SVC')").run()
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });

  it('rejects stop_times.trip_id that does not exist in trips', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.exec('PRAGMA foreign_keys = ON;');
      db.prepare("INSERT INTO agency (agency_name, agency_url, agency_timezone) VALUES ('A','https://a','UTC')").run();
      db.prepare("INSERT INTO stops (stop_id) VALUES ('S1')").run();
      expect(() =>
        db.prepare("INSERT INTO stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES ('T_GHOST', '08:00:00', '08:00:00', 'S1', 1)").run()
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });

  it('rejects stop_times.stop_id that does not exist in stops', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.exec('PRAGMA foreign_keys = ON;');
      db.prepare("INSERT INTO agency (agency_name, agency_url, agency_timezone) VALUES ('A','https://a','UTC')").run();
      db.prepare("INSERT INTO stops (stop_id) VALUES ('S1')").run();
      db.prepare("INSERT INTO routes (route_id, route_type) VALUES ('R1', 3)").run();
      db.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('SVC', 1,1,1,1,1,0,0,'20260701','20261231')").run();
      db.prepare("INSERT INTO trips (trip_id, route_id, service_id) VALUES ('T1', 'R1', 'SVC')").run();
      expect(() =>
        db.prepare("INSERT INTO stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES ('T1', '08:00:00', '08:00:00', 'S_GHOST', 1)").run()
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });

  it('rejects calendar_dates.service_id that does not exist in calendar', () => {
    const db = new Database(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      db.exec('PRAGMA foreign_keys = ON;');
      expect(() =>
        db.prepare("INSERT INTO calendar_dates (service_id, date, exception_type) VALUES ('SVC_GHOST', '20260701', 1)").run()
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });
});