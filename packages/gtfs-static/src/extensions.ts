/**
 * Per-feed SQLite extensions to the standard GTFS Schedule schema.
 *
 * These are NOT in the official GTFS spec. They're producer-side
 * extensions that this repo adds to its published sqlite to support
 * features the spec doesn't cover (e.g. per-network route grouping,
 * per-network colour palette for the consumer UI).
 *
 * Consumers of the published sqlite MAY ignore these tables; they're
 * only useful when the consumer renders a feed that uses networks.txt
 * / route_networks.txt (currently: none, but the table layout is
 * reserved for future feeds).
 *
 * Lives in gtfs-static (not @neary-gtfs/spec) because the published
 * GTFS spec library is strictly spec — no per-feed knowledge.
 */

import type { ColumnSpec, SchemaSpec } from '@n3ary/neary-gtfs-spec/sql';

type NetworksColumns = {
  network_id: ColumnSpec;
  network_name: ColumnSpec;
  network_color: ColumnSpec;
};

export const networksColumns: NetworksColumns = {
  network_id: ['network_id', 'TEXT PRIMARY KEY'],
  network_name: ['network_name', 'TEXT'],
  network_color: ['network_color', 'TEXT'],
};

export const networks: SchemaSpec = {
  file: 'networks.txt',
  columns: Object.values(networksColumns),
};

export const route_networks: SchemaSpec = {
  file: 'route_networks.txt',
  columns: [
    ['network_id', 'TEXT'],
    ['route_id', 'TEXT'],
  ],
  indexes: [
    ['route_networks_network_idx', '(network_id)'],
    ['route_networks_route_idx', '(route_id)'],
  ],
};

/** All per-feed extension tables, applied after the spec schema. */
export const EXTENSIONS: Record<string, SchemaSpec> = {
  networks,
  route_networks,
};

/** The extensions as a single SQL string, in table-declaration order. */
export const EXTENSIONS_SQL: string = (() => {
  const stmts: string[] = [];
  for (const [tableName, spec] of Object.entries(EXTENSIONS)) {
    const cols = spec.columns.map(([n, t]) => `${n} ${t}`).join(', ');
    stmts.push(`CREATE TABLE ${tableName} (${cols});`);
    for (const [idxName, idxCols] of spec.indexes ?? []) {
      stmts.push(`CREATE INDEX ${idxName} ON ${tableName} ${idxCols};`);
    }
  }
  return stmts.join('\n');
})();