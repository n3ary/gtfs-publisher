/**
 * Shared CSV serialization helpers for the GTFS spec writers.
 *
 * Mirror of `csv-parse.ts` — provides the *write* half of the CSV
 * round-trip. Both files dynamic-import their respective `csv-*`
 * packages on first use rather than as static imports, so this
 * package remains usable from browser/Worker contexts (the GTFS
 * worker inside n3ary/app pulls spec schemas/types but never
 * serializes CSV in the browser; the dynamic import keeps the
 * csv-stringify dependency out of the worker bundle).
 *
 * Why this exists:
 *   Before PR #81, every adapter hand-rolled its `*ToTxt` writers.
 *   Each one derived the header from `Object.keys(SomeRowSchema.shape)`
 *   (correct) but hand-positioned values against that header
 *   (drift-prone — PR #8 had to fix exactly this in cluj-napoca's
 *   `stopsToTxt`: values were shifted by one column, leaving the
 *   actual `stop_lat` column empty and breaking the orchestrator's
 *   `deriveBbox`). With `serializeRows`, the schema's column order
 *   drives BOTH header and value positions — drift becomes
 *   structurally impossible.
 *
 * GTFS we honour (mirrors csv-parse.ts):
 *   - First line is the header (when `header: true`)
 *   - Comma-separated; fields containing comma/quote/newline get
 *     double-quoted with embedded quotes doubled
 *   - Output uses \n line endings; trailing newline preserved
 *
 * Not honoured (don't appear in real GTFS):
 *   - Multi-line quoted fields
 */
import type { ZodType } from 'zod';

const STRINGIFY_OPTS = {
  header: true,
  // `columns: string[]` tells csv-stringify to emit exactly these
  // columns in this order, AND to extract values by those keys from
  // each row object. Without `columns`, csv-stringify uses
  // Object.keys() on the first row — which is order-dependent on
  // V8's hidden class layout, not spec order.
  //
  // No `quoted_string: true` — that's the "quote every string" flag,
  // which makes outputs larger than necessary and breaks naive
  // `split(',')` callers. csv-stringify's default is RFC 4180: only
  // quote when the field contains comma/quote/newline.
  record_delimiter: '\n',
} as const;

// Cached on first use. Same dynamic-import pattern as csv-parse.ts.
let csvStringifySyncPromise:
  | Promise<(records: unknown[], opts: typeof STRINGIFY_OPTS & { columns: readonly string[] }) => string>
  | null = null;

function loadCsvStringifySync() {
  if (!csvStringifySyncPromise) {
    csvStringifySyncPromise = import('csv-stringify/sync').then((m) => m.stringify);
  }
  return csvStringifySyncPromise;
}

/**
 * Extract the canonical column list from a zod schema's `.shape`.
 * Throws TypeError if the schema is not a `z.object(...)` (the only
 * shape that carries field order).
 *
 * Why `.shape` rather than `.shape()`:
 *   - `z.object({...}).shape` is a plain object whose insertion order
 *     matches the literal's declaration order. This IS the spec's
 *     reference order (we declare columns in the same order they
 *     appear in gtfs.org's reference table).
 *   - `z.object({...}).shape()` (the method) returns a frozen copy —
 *     same order, but adds a method call and loses some type info.
 *   - Other zod types (`z.string`, `z.array`, ...) don't have a
 *     meaningful column list and would error here.
 */
function columnsFromSchema<T>(schema: ZodType<T>): readonly string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof shape !== 'object') {
    const ctorName = (schema as { constructor?: { name?: string } }).constructor?.name;
    throw new TypeError(
      'serializeRows: schema must be z.object({...}); got ' +
        (ctorName ?? typeof schema),
    );
  }
  return Object.keys(shape);
}

/**
 * Serialize a batch of typed rows to a complete GTFS CSV body
 * (header line + data lines, trailing newline included).
 *
 * The schema drives column order — both the header line and each
 * data row's field positions come from `Object.keys(schema.shape)`.
 * Callers MUST pass an object-shaped schema (`z.object(...)`); other
 * zod types have no meaningful column order.
 *
 * Per-cell behaviour:
 *   - undefined / null  → empty cell
 *   - string containing comma/quote/newline → double-quoted with
 *     embedded quotes doubled (RFC 4180)
 *   - other primitives → String(value)
 *   - objects → JSON-encoded (rarely useful for GTFS; flag if you
 *     see it in a real output)
 *
 * The parser in `csv-parse.ts` reads the same CSV back via
 * `csv-parse/sync` with `columns: true` (default), so a
 * serializeRows → parseRows round-trip is structurally lossless for
 * any row that conforms to the schema.
 */
export async function serializeRows<T>(schema: ZodType<T>, rows: readonly T[]): Promise<string> {
  // Wrap in Promise.resolve so sync throws (TypeError from
  // columnsFromSchema, etc.) become rejections — callers using
  // `await expect(...).rejects.toThrow(...)` need a real rejected
  // promise, not a sync throw.
  const columns = await Promise.resolve(columnsFromSchema(schema));
  const stringify = await loadCsvStringifySync();
  return stringify(rows as unknown[], { ...STRINGIFY_OPTS, columns });
}

/**
 * Single-row convenience wrapper. Returns the CSV body (header + 1 row
 * + trailing newline). Exists so callers that build rows one at a time
 * (e.g. streaming pipelines) don't have to allocate a 1-element array
 * just to call `serializeRows`.
 *
 * Implementation note: csv-stringify/sync always wants an array of
 * records, so we wrap the single row. The wrapper allocation is
 * unavoidable without forking csv-stringify.
 */
export async function serializeRow<T>(schema: ZodType<T>, row: T): Promise<string> {
  return serializeRows(schema, [row]);
}