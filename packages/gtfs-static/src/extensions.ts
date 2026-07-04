/**
 * Producer-only SQLite additions to the public GTFS Schedule schema.
 *
 * The public spec itself (https://gtfs.org/schedule/reference/) is
 * defined in @n3ary/gtfs-spec — SCHEMA, SCHEMA_SQL, REQUIRED_TABLES.
 * This file adds what's specific to *our* pipeline on top of that:
 *
 *   1. COLUMN_EXTENSIONS — `ALTER TABLE ... ADD COLUMN` for fields the
 *      spec doesn't define but the app consumes. Currently: the
 *      producer-computed per-network chip color, written by
 *      lib/route-colors.ts at build time. The app reads it verbatim
 *      from the sqlite — all color math is here, not in the app.
 *
 *   2. TABLE_EXTENSIONS — `CREATE TABLE` for pipeline-internal tables
 *      that aren't part of any GTFS feed. Currently: `_neary_config`,
 *      a key/value bag for per-feed runtime config (e.g. timing
 *      windows) that the app reads back at runtime.
 *
 * Apply with `EXTENSIONS_SQL` after the spec DDL. Order matters:
 * ALTER TABLE first (depends on spec tables existing), then CREATE
 * TABLE (no dependencies).
 *
 * Lives in gtfs-static (not @n3ary/gtfs-spec) because the published
 * GTFS spec library is strictly public — no per-pipeline knowledge.
 */

import type { ColumnSpec, SchemaSpec } from '@n3ary/gtfs-spec/sql';

/** Per-table column extension. ALTER TABLE <table> ADD COLUMN <col>. */
export type ColumnExtension = {
  /** Existing spec table to extend (must already be in SCHEMA). */
  table: string;
  /** [name, sqlType] for the new column. */
  column: ColumnSpec;
};

/**
 * Producer-computed columns added to public spec tables. The static
 * pipeline writes these at build time; the app reads them verbatim.
 */
export const COLUMN_EXTENSIONS: readonly ColumnExtension[] = [
  {
    table: 'networks',
    // Computed by lib/route-colors.ts (computeNetworkColors) — see
    // that file for the palette algorithm. Hex without leading #,
    // matching the convention used by routes.route_color.
    column: ['network_color', 'TEXT'],
  },
];

/**
 * Producer-only tables. Apply after the spec schema + the column
 * extensions (the table extensions may reference spec columns).
 */
export const TABLE_EXTENSIONS: Record<string, SchemaSpec> = {
  _neary_config: {
    // Not a real GTFS file — internal producer table.
    file: '_neary_config',
    columns: [
      ['key', 'TEXT PRIMARY KEY'],
      ['value', 'TEXT NOT NULL'],
    ],
  },
};

/** All per-feed extension DDL as a single SQL string, in dependency order. */
export const EXTENSIONS_SQL: string = (() => {
  const stmts: string[] = [];
  // 1. ALTER TABLE ADD COLUMN — must run after the spec tables exist.
  for (const { table, column } of COLUMN_EXTENSIONS) {
    stmts.push(`ALTER TABLE ${table} ADD COLUMN ${column[0]} ${column[1]};`);
  }
  // 2. CREATE TABLE — no spec dependencies.
  for (const [tableName, spec] of Object.entries(TABLE_EXTENSIONS)) {
    const cols = spec.columns.map(([n, t]) => `${n} ${t}`).join(', ');
    stmts.push(`CREATE TABLE ${tableName} (${cols});`);
    for (const [idxName, idxCols] of spec.indexes ?? []) {
      stmts.push(`CREATE INDEX ${idxName} ON ${tableName} ${idxCols};`);
    }
  }
  return stmts.join('\n');
})();