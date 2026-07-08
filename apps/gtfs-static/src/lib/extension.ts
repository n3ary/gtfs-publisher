/**
 * extension.ts — adapter-supplied additions to the GTFS Schedule sqlite.
 *
 * `gtfs-static` is the generic GTFS.zip -> sqlite3.gz pipeline. It applies
 * the public spec schema (`@n3ary/gtfs-spec/sql.SCHEMA`) plus whatever
 * per-feed extras the caller hands in via `StaticExtension`. The pipeline
 * itself owns no per-feed knowledge — every column or table that doesn't
 * come from the public GTFS Schedule spec arrives via this interface.
 *
 * The actual extension implementations live in
 * `n3ary/gtfs-adapters/adapters/<feed>/src/static/extension.ts`. One
 * adapter per feed (or per upstream source family).
 *
 * Why `fillComputedColumns` is a PURE function (returns data) rather
 * than a callback (mutates the DB):
 *   - Adapters stay SQL-engine-agnostic. They never import a SQLite
 *     driver. They don't even know which driver the pipeline uses.
 *   - The pipeline owns every SQL statement in the build. Audit surface
 *     is one repo, one file (make-sqlite.ts), no per-adapter SQL drift.
 *   - The contract becomes: take rows in, return rows out. Pure data
 *     means pure tests — no database fixture, no driver import.
 *
 * The pipeline walks the returned `ComputedUpdates` and constructs
 * `UPDATE <table> SET <cols...> WHERE <pk...>` using the spec's PK
 * metadata. Adapters describe WHAT (a route should be FF0000), the
 * pipeline describes HOW (UPDATE ... WHERE route_id = ?).
 */

import type { ColumnSpec } from '@n3ary/gtfs-spec/sql';

/**
 * `ALTER TABLE <table> ADD COLUMN <column>` — must reference a table
 * that already exists in the spec `SCHEMA`.
 */
export type ColumnExtension = {
  table: string;
  column: ColumnSpec;
};

/**
 * Pipeline-internal table (not in any GTFS spec). Created via
 * `CREATE TABLE`, then `rows` (if provided) are inserted verbatim.
 */
export type TableExtension = {
  columns: ColumnSpec[];
  rows?: ReadonlyArray<Record<string, unknown>>;
};

/**
 * Read access to the small buffered spec tables during the
 * `fillComputedColumns` hook. The three tables in `ctx` are the only
 * ones the pipeline keeps in memory; large spec tables (`stop_times`,
 * `shapes`) are streamed and not exposed.
 */
export type ExtensionContext = {
  readonly feedId: string;
  readonly routes: ReadonlyArray<Record<string, unknown>>;
  readonly networks: ReadonlyArray<Record<string, unknown>>;
  readonly routeNetworks: ReadonlyArray<Record<string, unknown>>;
};

/**
 * Per-table partial-row updates returned by `fillComputedColumns`. Key
 * shape:
 *   tableName -> [ { pk_col_1: ..., pk_col_2?: ..., column_to_set: ... }, ... ]
 *
 * The pipeline locates the PK columns from the spec's SCHEMA
 * (`@n3ary/gtfs-spec/sql`) and issues one UPDATE per row inside a
 * transaction. Tables not in SCHEMA (i.e. table extensions from the same
 * StaticExtension object) cannot be updated here — those rows are
 * either pre-supplied via `TableExtension.rows` or omitted entirely.
 */
export type ComputedUpdates = {
  readonly [tableName: string]: ReadonlyArray<Record<string, unknown>>;
};

/**
 * Pure data-in / data-out hook. The adapter computes the values; the
 * pipeline owns the SQL that persists them.
 *
 * Async is allowed because some adapters may want to fetch external
 * material (e.g. a configured palette per feed). Returning an empty
 * object is a valid no-op.
 */
export type FillComputedColumnsHook = (
  context: ExtensionContext,
) => ComputedUpdates | Promise<ComputedUpdates>;

/**
 * Per-feed additions to a sqlite build. All three fields are optional —
 * a feed that needs only spec tables can pass `undefined`. The pipeline
 * applies them in this order:
 *
 *   1. `columnExtensions` — DDL only; the column is created but
 *      NOT NULL leaves nulls in existing rows, defaults to NULL if
 *      not set, and column-level CHECK constraints (if any) take
 *      effect at INSERT time.
 *   2. `tableExtensions` — `CREATE TABLE` (after spec schema), then
 *      `rows` are inserted if provided.
 *   3. `fillComputedColumns` — runs after all spec CSVs are loaded.
 *      The adapter examines `ctx` and returns a `ComputedUpdates`
 *      object describing per-table partial rows to UPDATE by PK.
 *      The pipeline applies the SQL itself.
 */
export interface StaticExtension {
  columnExtensions?: ReadonlyArray<ColumnExtension>;
  tableExtensions?: Readonly<Record<string, TableExtension>>;
  fillComputedColumns?: FillComputedColumnsHook;
}
