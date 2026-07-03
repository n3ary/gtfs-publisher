// Barrel. Three subpaths:
//
//   import { AgencySchema } from '@n3ary/neary-gtfs-spec/schema';  // registry-publication shapes
//   import { parseAgency }   from '@n3ary/neary-gtfs-spec/spec';    // per-spec-file readers
//   import { SCHEMA_SQL }    from '@n3ary/neary-gtfs-spec/sql';     // canonical DDL
//
// This barrel re-exports everything for callers who want a single import.

export * from './spec/index.js';
export * from './schema/index.js';
export * from './sql/index.js';
