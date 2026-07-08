/**
 * Shared CSV parsing helpers for the GTFS spec readers in this package.
 *
 * GTFS we honour (per the spec files we ship):
 *   - First non-empty line is the header
 *   - Comma-separated; double-quote escaped fields support embedded commas
 *   - Lines may end with \n or \r\n
 *   - UTF-8 BOM on the first line is stripped
 *   - relax_quotes: true, relax_column_count: true (real-world feeds vary)
 *
 * Not honoured (don't appear in real GTFS):
 *   - Multi-line quoted fields
 *
 * csv-parse is loaded dynamically on the first parseRows / parseRowsStream
 * call rather than as a static import. The reason: this package is also
 * consumed from the browser (the GTFS worker inside n3ary/app), and
 * csv-parse is a Node-flavored library — it pulls `stream.Transform` and
 * `Buffer` at module-load time, both undefined in browser/Worker
 * contexts. A static import would force every consumer of any spec
 * reader to also carry csv-parse (and its Node externals) through their
 * bundler, even if the consumer never actually parses CSV in that
 * context. Dynamic import keeps csv-parse out of the import graph until
 * a real parse call happens.
 */
import type { ZodType } from 'zod';

const PARSE_OPTS = {
  columns: true,
  skip_empty_lines: true,
  relax_quotes: true,
  relax_column_count: true,
  trim: true,
  bom: true,
} as const;

// Cached on first use. The dynamic-import promise resolves once; subsequent
// callers reuse the resolved module reference.
let csvParseSyncPromise:
  | Promise<(text: string, opts: typeof PARSE_OPTS) => Record<string, string>[]>
  | null = null;
let csvParseAsyncPromise:
  | Promise<(opts: typeof PARSE_OPTS) => NodeJS.ReadWriteStream>
  | null = null;

function loadCsvParseSync() {
  if (!csvParseSyncPromise) {
    csvParseSyncPromise = import('csv-parse/sync').then((m) => m.parse);
  }
  return csvParseSyncPromise;
}

function loadCsvParseAsync() {
  if (!csvParseAsyncPromise) {
    csvParseAsyncPromise = import('csv-parse').then((m) => m.parse);
  }
  return csvParseAsyncPromise;
}

/**
 * Parse a complete CSV text in one pass. Returns validated rows.
 *
 * Async because csv-parse is loaded via dynamic import (see the file
 * header for why). Fine for small files (agency.txt, calendar.txt,
 * routes.txt, stops.txt, trips.txt for most feeds). For stop_times.txt
 * and shapes.txt, which routinely exceed 500 MB uncompressed, prefer
 * {@link parseRowsStream}.
 */
export async function parseRows<T>(
  schema: ZodType<T>,
  text: string,
): Promise<T[]> {
  const csvParseSync = await loadCsvParseSync();
  const records = csvParseSync(text, PARSE_OPTS) as Record<string, string>[];
  const out: T[] = [];
  for (const r of records) {
    out.push(schema.parse(r));
  }
  return out;
}

/**
 * Stream-parse a CSV. The `source` iterable yields chunks of CSV text
 * (e.g. from `zip.stream(filename)` in `node-stream-zip`). The returned
 * async iterable yields validated rows one at a time, so peak memory
 * stays bounded regardless of input size.
 *
 * For stop_times.txt and shapes.txt, which routinely exceed Node's max
 * string length (~512 MB v8 kMaxLength) on national feeds, this is the
 * only safe option.
 */
export async function* parseRowsStream<T>(
  schema: ZodType<T>,
  source: AsyncIterable<string>,
): AsyncGenerator<T> {
  // csv-parse's async API accepts a Node Readable. We wrap the incoming
  // async iterable into one using `Readable.from` (Node 20+). node:stream
  // is only dynamically imported inside this generator, so the spec
  // bundle stays Node-free at module-load time and can be loaded by
  // browser-side consumers (e.g. the GTFS worker) without dragging in
  // stream's externalized-stub chain.
  const { Readable } = await import('node:stream');
  const csvParseAsync = await loadCsvParseAsync();
  const readable = Readable.from(source as AsyncIterable<string>);
  const parser = readable.pipe(
    csvParseAsync(PARSE_OPTS) as unknown as NodeJS.ReadWriteStream,
  );
  for await (const r of parser) {
    yield schema.parse(r as unknown as Record<string, string>);
  }
}