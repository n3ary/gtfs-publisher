/**
 * GTFS Schedule CSV readers — one per spec file in the Schedule reference.
 *
 * https://gtfs.org/documentation/schedule/reference/
 *
 * Each reader exposes:
 *   - A `<SpecName>RowSchema` (Zod) — column-level validation per spec.
 *   - A `parse<SpecName>(text)` — sync, returns all validated rows.
 *   - A `parse<SpecName>Stream(source)` — async, validates streaming.
 *
 * Use the sync variant only for files small enough to fit comfortably
 * in memory (agency, calendar, calendar_dates, feed_info, routes,
 * stops, trips). For stop_times.txt and shapes.txt, which routinely
 * exceed 500 MB uncompressed on national feeds, the sync reader is
 * intentionally not exported — only the streaming variant exists.
 *
 * All schemas are `.passthrough()` rather than `.strict()`: real-world
 * GTFS feeds often include columns beyond the spec (extensions,
 * vendor-specific fields). Validation rejects obviously bad values
 * (e.g. `agency_url: ""`) but doesn't lock down the column set.
 *
 * The serializer (`serializeRows`, `serializeRow`) is re-exported
 * here so adapters get schemas + the writer that pairs with them
 * from a single import path. The column order comes from
 * `Object.keys(schema.shape)` — same source the parser validates
 * against, so header + values can't drift.
 *
 * Per-feed quirks belong in `packages/gtfs-rt/src/quirks/<feed>.ts`,
 * never here. This module is GTFS-spec only.
 */

export * from './agency.js';
export * from './stops.js';
export * from './routes.js';
export * from './trips.js';
export * from './stop_times.js';
export * from './calendar.js';
export * from './calendar_dates.js';
export * from './shapes.js';
export * from './frequencies.js';
export * from './feed_info.js';
export * from './networks.js';
export * from './route_networks.js';
export { serializeRows, serializeRow, networksToTxt, routeNetworksToTxt } from '../serialize/index.js';