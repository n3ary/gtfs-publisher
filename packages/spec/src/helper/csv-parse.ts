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
 */

import { parse as csvParseSync } from 'csv-parse/sync';
import { parse as csvParseAsync } from 'csv-parse';
import type { ZodType } from 'zod';

const PARSE_OPTS = {
  columns: true,
  skip_empty_lines: true,
  relax_quotes: true,
  relax_column_count: true,
  trim: true,
  bom: true,
} as const;

/**
 * Parse a complete CSV text in one pass. Returns validated rows.
 *
 * Synchronous — fine for small files (agency.txt, calendar.txt, routes.txt,
 * stops.txt, trips.txt for most feeds). For stop_times.txt and shapes.txt,
 * which routinely exceed 500 MB uncompressed, prefer {@link parseRowsStream}.
 */
export function parseRows<T>(
  schema: ZodType<T>,
  text: string,
): T[] {
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
  // async iterable into one using `Readable.from` (Node 20+).
  const { Readable } = await import('node:stream');
  const readable = Readable.from(source as AsyncIterable<string>);
  const parser = readable.pipe(
    csvParseAsync(PARSE_OPTS) as unknown as NodeJS.ReadWriteStream,
  );
  for await (const r of parser) {
    yield schema.parse(r as unknown as Record<string, string>);
  }
}