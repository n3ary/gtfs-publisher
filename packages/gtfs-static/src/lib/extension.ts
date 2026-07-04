/**
 * extension.ts — adapter-supplied additions to the GTFS Schedule sqlite.
 *
 * `gtfs-static` is the generic GTFS.zip → sqlite3.gz pipeline. It applies
 * the public spec schema (`@n3ary/gtfs-spec/sql.SCHEMA`) plus whatever
 * per-feed extras the caller hands in via `StaticExtension`. The pipeline
 * itself owns no per-feed knowledge — every column or table that doesn't
 * come from the public GTFS Schedule spec arrives via this interface.
 *
 * The actual extension implementations live in
 * `n3ary/gtfs-adapters/adapters/<feed>/src/static/extension.ts`. One
 * adapter per feed (or per upstream source family).
 */

import type Database from 'better-sqlite3';
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

export type FillComputedColumnsHook = (
  db: Database.Database,
  context: ExtensionContext,
) => void | Promise<void>;

/**
 * Per-feed additions to a sqlite build. All three fields are optional —
 * a feed that needs only spec tables can pass `undefined`. The pipeline
 * applies them in this order:
 *
 *   1. `columnExtensions` — DDL only; the column values are filled by
 *      `fillComputedColumns` or by a static UPDATE inside that hook.
 *   2. `tableExtensions` — `CREATE TABLE` (after spec schema), then
 *      `rows` are inserted if provided.
 *   3. `fillComputedColumns` — runs after all spec CSVs are loaded.
 *      Use this for column values that depend on spec data (e.g. the
 *      per-network chip color, derived from routes + route_networks +
 *      networks). Mutating `ctx.routes` etc. has no effect — call
 *      `db.prepare(...)` to persist.
 */
export interface StaticExtension {
  columnExtensions?: ReadonlyArray<ColumnExtension>;
  tableExtensions?: Readonly<Record<string, TableExtension>>;
  fillComputedColumns?: FillComputedColumnsHook;
}
