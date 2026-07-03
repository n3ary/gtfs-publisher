// Barrel. Two subpaths:
//
//   import { parseAgency, AgencyRowSchema } from '@neary-gtfs/spec/spec';
//   import { AgencySchema } from '@neary-gtfs/spec/schema';
//
// This barrel re-exports both so callers who want everything can write:
//
//   import * as Spec from '@neary-gtfs/spec';

export * from './spec/index.js';
export * from './schema/index.js';