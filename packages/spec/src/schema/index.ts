/**
 * GTFS-spec types and Zod schemas. Zero per-feed knowledge —
 * every shape here mirrors the GTFS Schedule / GTFS Realtime spec
 * directly, or a derived primitive the static pipeline computes
 * from spec input.
 *
 * Importing this module: prefer the schema for runtime validation,
 * the type alias for compile-time shape. Each schema is `.strict()`
 * so undeclared keys are rejected — protects against accidental
 * shape drift as the spec evolves.
 *
 * Re-exports a barrel; prefer `import { Agency } from '@n3ary/neary-gtfs-spec/schema'`
 * over reaching into individual files.
 */

export { AgencySchema, type Agency } from './agency.js';
export { BboxSchema, CenterSchema, ValiditySchema, type Bbox, type Center, type Validity } from './geometry.js';
export { RealtimeSchema, type Realtime } from './realtime.js';
export { LicenseSchema, type License } from './license.js';