// SQL DDL subpath. Three exports:
//
//   import { SCHEMA, SCHEMA_SQL, REQUIRED_TABLES } from '@n3ary/neary-gtfs-spec/sql';
//
// SCHEMA is the structural definition (used by the static pipeline's
// per-table insert code). SCHEMA_SQL is the same DDL as one string
// (used by drivers via db.exec). REQUIRED_TABLES marks the tables a
// GTFS feed must ship for the produced sqlite to be considered usable.

export {
  SCHEMA,
  SCHEMA_SQL,
  REQUIRED_TABLES,
  type SchemaSpec,
  type ColumnSpec,
} from './ddl.js';