/**
 * Public API for GTFS Schedule CSV serializers.
 *
 * Mirrors `csv-parse.ts`'s re-export role, but for the *write* direction.
 * Consumers (adapters, the orchestrator's `make-sqlite` if it ever
 * writes) import from `@n3ary/gtfs-spec/serialize` (or re-exported
 * via `@n3ary/gtfs-spec/spec`) and get:
 *
 *   - `serializeRows(schema, rows)` — full CSV body (header + rows)
 *   - `serializeRow(schema, row)`    — single-row convenience
 *   - `networksToTxt(rows)`          — networks.txt convenience
 *   - `routeNetworksToTxt(rows)`    — route_networks.txt convenience
 *
 * All async because the underlying `csv-stringify/sync` is
 * dynamic-imported (see csv-serialize.ts for why this matters for
 * browser/Worker consumers of the spec package).
 */

export { serializeRows, serializeRow } from '../helper/csv-serialize.js';
export { networksToTxt, routeNetworksToTxt } from '../helper/networks-serialize.js';