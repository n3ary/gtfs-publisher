/**
 * networks.txt + route_networks.txt convenience serializers.
 *
 * These two tables are tiny (5 columns total) and hand-rolled in
 * every adapter that emits networks, so the spec ships ready-made
 * writers. Use `serializeRows(NetworksRowSchema, rows)` + etc. when
 * you need type-driven column order; use these helpers when you
 * already have a plain string[] / string[][] and just want RFC 4180
 * quoting.
 *
 * Both:
 *   - Return empty string for empty input (matches the pre-PR
 *     convention in cluj-napoca's `emit/networks.ts` where the
 *     orchestrator drops the file from the zip when no rows exist).
 *   - Use `\n` line endings and a trailing newline.
 *   - Quote fields containing comma/quote/newline per RFC 4180.
 */
import { stringify } from 'csv-stringify/sync';

const NETWORKS_HEADER = 'network_id,network_name';
const ROUTE_NETWORKS_HEADER = 'network_id,route_id';

/** Serialize a list of `[network_id, network_name]` rows to networks.txt body. */
export function networksToTxt(rows: ReadonlyArray<readonly [string, string]>): string {
  if (rows.length === 0) return '';
  return stringify([...rows], {
    header: true,
    columns: ['network_id', 'network_name'],
    record_delimiter: '\n',
  });
}

/** Serialize a list of `[network_id, route_id]` rows to route_networks.txt body. */
export function routeNetworksToTxt(rows: ReadonlyArray<readonly [string, string]>): string {
  if (rows.length === 0) return '';
  return stringify([...rows], {
    header: true,
    columns: ['network_id', 'route_id'],
    record_delimiter: '\n',
  });
}

// Re-export the headers for callers that want to inspect them (e.g.
// tests that diff against a literal CSV body).
export { NETWORKS_HEADER, ROUTE_NETWORKS_HEADER };