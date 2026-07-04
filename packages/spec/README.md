# `@n3ary/gtfs-spec`

The canonical GTFS spec library for the [neary](https://github.com/n3ary/neary) family. Strictly GTFS Schedule spec — types, CSV readers, and SQLite DDL. Zero per-feed knowledge.

## API

Three subpaths:

```ts
import { AgencySchema } from '@n3ary/gtfs-spec/schema';
import { parseAgency } from '@n3ary/gtfs-spec/spec';
import { SCHEMA, SCHEMA_SQL, REQUIRED_TABLES } from '@n3ary/gtfs-spec/sql';
```

Or import everything from the barrel:

```ts
import * as Spec from '@n3ary/gtfs-spec';
```

### `/spec` — per-spec-file readers

9 readers, one per GTFS Schedule spec file. Each reader exports:

- `<SpecName>RowSchema` (Zod, column-level validation per the official reference)
- `parse<SpecName>(text)` (sync, returns all validated rows)
- `parse<SpecName>Stream(source)` (async, yields validated rows one at a time)
- `<SpecName>Row` (inferred TS type)

For `stop_times.txt` and `shapes.txt` (routinely exceed 500 MB uncompressed on national feeds) only the streaming reader is exported.

### `/schema` — registry-publication shapes

- `Agency` — agency from `agency.txt`
- `Bbox`, `Center`, `Validity` — derived metadata primitives
- `Realtime` — GTFS-RT URL bundle
- `License` — attribution contract

Each has a paired Zod schema (`AgencySchema`, etc.) and a `z.infer`-style TS type.

### `/sql` — canonical SQLite DDL

- `SCHEMA` — per-table structural definition (columns, indexes, composite PK, `WITHOUT ROWID`).
- `SCHEMA_SQL` — same DDL as one SQL string.
- `REQUIRED_TABLES` — `['agency', 'routes', 'stop_times', 'stops', 'trips']`.
- `SchemaSpec` — type of a single table definition.

Browser-compatible — does not import any native driver.

## Install

```bash
# In your .npmrc:
#   @n3ary:registry=https://npm.pkg.github.com

npm install @n3ary/gtfs-spec
```

## Build / test

```bash
pnpm install --frozen-lockfile --trust-lockfile
pnpm build
pnpm test
```

## Why this library exists

Per the [gtfs-rt-contract.md](https://github.com/n3ary/neary/blob/main/docs/specs/gtfs-rt-contract.md), per-feed quirks live in the producer only. This library is the shared canonical contract across the n3ary org (app, gtfs, standards, cluj-napoca-gtfs-adapter).

## Source

[https://github.com/n3ary/gtfs/tree/main/packages/spec](https://github.com/n3ary/gtfs/tree/main/packages/spec)

## License

Per-feed licenses apply to GTFS data ingested by the producer. The library code itself is licensed under the same terms as the rest of the n3ary/gtfs repo.
