// Placeholder barrel. Content lives in ./schema/ until issue #34
// step 4 adds CSV readers and step 5 adds SQLite DDL. Once those land,
// re-export them here so consumers can write `import { AgencySchema }
// from '@neary-gtfs/shared'`.

export * from './schema/index.js';